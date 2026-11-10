"""Swap check: is the original person still in the model output?

Usage: python3 faces.py <output.mp4> <original.mp4> <seconds> '<[[x, y] or [x, y, t], ...]>'
For each point (a face center in the original as fractions of width and height, read from the frame at t seconds, the first frame
when t is omitted) prints, as a JSON list in the same order,
the highest cosine similarity between that original face and any face in 16 frames spread over the first `seconds` of the output.
A missed swap scores 0.85+, a swapped person stays under 0.4. A point with no face in the original prints 0.

Likeness: python3 faces.py likeness <output.mp4> '<[{"photo": path, "ranges": [[start, end], ...]}, ...]>'
For each person prints how much the output looks like their photo: in frames sampled over their ranges (seconds), the best match to the
photo's face per frame, then the median, so a few good frames don't hide a drifted face. null when the photo has no face or no frame was read.
The same person scores about 0.45–0.7 in a close-up; a different face stays under 0.36.

Models: OpenCV Zoo YuNet (detection) and SFace (recognition), baked into the image under /app/models.
"""
import json
import os
import statistics
import sys

import cv2

MODELS = os.environ.get('FACE_MODELS', '/app/models')
# At least 16 frames, and 2 per second for long clips: a whole-clip edit can keep the original person for just a second or two.
SAMPLES = 16
SAMPLES_PER_SECOND = 2
detector = cv2.FaceDetectorYN.create(f'{MODELS}/yunet.onnx', '', (320, 320), 0.6)
recognizer = cv2.FaceRecognizerSF.create(f'{MODELS}/sface.onnx', '')


def faces(image):
    """(center x, center y, feature) for each face that isn't tiny (posters and photos on the shelves don't count)."""
    height, width = image.shape[:2]
    detector.setInputSize((width, height))
    _, found = detector.detect(image)
    result = []
    for face in found if found is not None else []:
        if face[2] * face[3] < 0.003 * width * height:
            continue
        feature = recognizer.feature(recognizer.alignCrop(image, face))
        result.append(((face[0] + face[2] / 2) / width, (face[1] + face[3] / 2) / height, feature))
    return result


def frames(path, seconds, count, with_times=False):
    capture = cv2.VideoCapture(path)
    end = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = capture.get(cv2.CAP_PROP_FPS)
    if fps > 0:
        end = min(end, int(seconds * fps))
    result = []
    for i in range(count):
        index = int(end * (i + 0.5) / count)
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, image = capture.read()
        if ok:
            result.append((image, index / fps if fps > 0 else 0.0) if with_times else image)
    return result


def original_frame(path, seconds):
    capture = cv2.VideoCapture(path)
    if seconds > 0:
        capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
    ok, image = capture.read()
    if not ok:
        raise SystemExit(f'cannot read the original clip at {seconds}s')
    return image


def likeness(output, people):
    capture = cv2.VideoCapture(output)
    fps = capture.get(cv2.CAP_PROP_FPS) or 24
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    found = {}

    def faces_at(index):
        if index not in found:
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, image = capture.read()
            found[index] = [face[2] for face in faces(image)] if ok else None
        return found[index]

    scores = []
    for person in people:
        image = cv2.imread(person['photo'])
        # A prep photo shows one person filling the frame: its first face is them.
        in_photo = faces(image) if image is not None else []
        target = in_photo[0][2] if in_photo else None
        indices = []
        for start, end in person['ranges']:
            first, last = int(start * fps), min(int(end * fps), total)
            # 2 frames per second, at least 8 per person, skipping the frames right at a cut.
            count = max(8 // len(person['ranges']), round((end - start) * SAMPLES_PER_SECOND))
            indices += [first + int((last - first) * (i + 0.5) / count) for i in range(count)] if last > first else []
        best = []
        for index in indices:
            seen = faces_at(index)
            if seen is None or target is None:
                continue
            best.append(max((recognizer.match(target, feature, cv2.FaceRecognizerSF_FR_COSINE) for feature in seen), default=0.0))
        scores.append(round(max(0.0, float(statistics.median(best))), 3) if best else None)
    return scores


def main():
    if sys.argv[1] == 'likeness':
        print(json.dumps(likeness(sys.argv[2], json.loads(sys.argv[3]))))
        return
    output, original, seconds, points = sys.argv[1], sys.argv[2], float(sys.argv[3]), json.loads(sys.argv[4])
    # Optional: per point, the time ranges of the output to look in (the shots it stands for).
    windows = json.loads(sys.argv[5]) if len(sys.argv) > 5 else None
    by_time = {}
    targets = []
    for point in points:
        x, y = point[0], point[1]
        t = point[2] if len(point) > 2 else 0.0
        if t not in by_time:
            by_time[t] = faces(original_frame(original, t))
        originals = by_time[t]
        nearest = min(originals, key=lambda f: (f[0] - x) ** 2 + (f[1] - y) ** 2, default=None)
        # Only trust a face that is actually near the configured point.
        targets.append(nearest[2] if nearest and (nearest[0] - x) ** 2 + (nearest[1] - y) ** 2 < 0.15 ** 2 else None)
    sampled = frames(output, seconds, max(SAMPLES, round(seconds * SAMPLES_PER_SECOND)), with_times=True)
    if not sampled:
        raise SystemExit('cannot read the output')
    found = [(at, face[2]) for image, at in sampled for face in faces(image)]
    scores = []
    for i, target in enumerate(targets):
        if target is None:
            scores.append(0.0)
            continue
        ranges = windows[i] if windows else None
        seen = [feature for at, feature in found if ranges is None or any(start <= at <= end for start, end in ranges)]
        best = max((recognizer.match(target, feature, cv2.FaceRecognizerSF_FR_COSINE) for feature in seen), default=0.0)
        scores.append(round(max(0.0, float(best)), 3))
    print(json.dumps(scores))


if __name__ == '__main__':
    main()
