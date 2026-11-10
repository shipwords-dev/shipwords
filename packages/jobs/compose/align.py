"""Put a repaired clip back over the frames it was cut from, lined up frame by frame.

Usage: python3 align.py <video.mp4> <patch.mp4> <output.mp4> '<spec JSON>'
spec: { "ranges": [[start, end), ...] frames, "box": {"x", "y", "w", "h"} pixels or null for the whole frame, "fps": n }

Replace models don't hand back exactly the frames they were given: they crop to their own aspect, and the background can drift or zoom
a little over a shot. Stretching the clip over the box then leaves the shelves behind the person misaligned at its edges. Here every
repaired frame is matched to the frame it replaces on the background (ORB features, RANSAC similarity transform, smoothed over time),
warped onto it, and blended in with feathered inner edges; what the clip doesn't cover keeps the original. Frames where no transform
can be found use their neighbours', and a clip with none at all is stretched over the box as before. Audio is copied from the video.
Prints a JSON summary: frames replaced and how many were matched.
"""

import json
import subprocess
import sys

import cv2
import numpy as np

FEATHER = 24
MIN_INLIERS = 12
SMOOTH = 5


def frame_count(capture):
    return int(capture.get(cv2.CAP_PROP_FRAME_COUNT))


class PatchReader:
    """Frames of the repaired clip by index, read forward only and scaled to the box width (keeping the clip's aspect)."""

    def __init__(self, path, width):
        self.capture = cv2.VideoCapture(path)
        self.count = frame_count(self.capture)
        self.width = width
        self.index = -1
        self.frame = None

    def get(self, k):
        while self.index < k:
            ok, frame = self.capture.read()
            if not ok:
                break
            self.index += 1
            h, w = frame.shape[:2]
            self.frame = cv2.resize(frame, (self.width, max(2, round(self.width * h / w))), interpolation=cv2.INTER_AREA)
        return self.frame


def background_mask(h, w, whole):
    """Where to look for features: for a box, leave out the middle where the person is; the whole frame is left to RANSAC."""
    mask = np.full((h, w), 255, np.uint8)
    if not whole:
        cv2.ellipse(mask, (w // 2, int(h * 0.6)), (int(w * 0.32), int(h * 0.42)), 0, 0, 360, 0, -1)
    return mask


def estimate(orb, matcher, region, patch, mask):
    """Similarity transform taking patch pixels onto region pixels, or None."""
    g1 = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    k1, d1 = orb.detectAndCompute(g1, mask)
    k2, d2 = orb.detectAndCompute(g2, None)
    if d1 is None or d2 is None or len(k1) < MIN_INLIERS or len(k2) < MIN_INLIERS:
        return None
    matches = sorted(matcher.match(d2, d1), key=lambda m: m.distance)[:500]
    if len(matches) < MIN_INLIERS:
        return None
    src = np.float32([k2[m.queryIdx].pt for m in matches])
    dst = np.float32([k1[m.trainIdx].pt for m in matches])
    transform, inliers = cv2.estimateAffinePartial2D(src, dst, ransacReprojThreshold=2.0)
    if transform is None or inliers is None or int(inliers.sum()) < MIN_INLIERS:
        return None
    a, b = transform[0, 0], transform[1, 0]
    scale = float(np.hypot(a, b))
    angle = abs(float(np.degrees(np.arctan2(b, a))))
    h, w = region.shape[:2]
    if not (0.8 <= scale <= 1.25) or angle > 5 or abs(transform[0, 2]) > 0.3 * w or abs(transform[1, 2]) > 0.3 * h:
        return None
    return transform


def smooth(transforms):
    """Fill gaps from the nearest matched frames, then a running median, so one bad match doesn't make the patch jump."""
    known = [i for i, t in enumerate(transforms) if t is not None]
    if not known:
        return None
    filled = []
    for i, t in enumerate(transforms):
        if t is None:
            j = min(known, key=lambda k: abs(k - i))
            t = transforms[j]
        filled.append(np.array([t[0, 0], t[1, 0], t[0, 2], t[1, 2]]))
    filled = np.array(filled)
    half = SMOOTH // 2
    out = []
    for i in range(len(filled)):
        a, b, tx, ty = np.median(filled[max(0, i - half): i + half + 1], axis=0)
        out.append(np.array([[a, -b, tx], [b, a, ty]], np.float32))
    return out


def feather(h, w, box, frame_w, frame_h):
    """Opaque inside, fading over FEATHER pixels at edges inside the frame; hard at the frame border (nothing to blend with there)."""
    ys = np.arange(h, dtype=np.float32)[:, None]
    xs = np.arange(w, dtype=np.float32)[None, :]
    big = np.float32(FEATHER)
    left = xs if box['x'] > 0 else big
    right = (w - 1 - xs) if box['x'] + w < frame_w else big
    top = ys if box['y'] > 0 else big
    bottom = (h - 1 - ys) if box['y'] + h < frame_h else big
    edge = np.minimum(np.minimum(left, right), np.minimum(top, bottom))
    return np.clip(edge / FEATHER, 0, 1) * np.ones((h, w), np.float32)


def main():
    video, patch_path, output, spec = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
    ranges, box, fps = spec['ranges'], spec.get('box'), spec['fps']
    capture = cv2.VideoCapture(video)
    total = frame_count(capture)
    frame_w = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    whole = box is None
    if whole:
        box = {'x': 0, 'y': 0, 'w': frame_w, 'h': frame_h}
    bw, bh = box['w'], box['h']
    targets = [n for start, end in ranges for n in range(max(0, start), min(end, total))]
    clip = PatchReader(patch_path, bw)
    if not targets or clip.count <= 0 or clip.get(0) is None:
        raise SystemExit('nothing to patch')
    # The clip is retimed to the ranges' length; each target frame takes the clip frame at the same relative time.
    pick = [min(clip.count - 1, int(k * clip.count / len(targets))) for k in range(len(targets))]
    scaled_h = clip.get(0).shape[0]

    orb = cv2.ORB_create(3000)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    mask = background_mask(bh, bw, whole)
    regions = {}
    position = {n: i for i, n in enumerate(targets)}
    transforms = [None] * len(targets)
    for n in range(total):
        ok, frame = capture.read()
        if not ok:
            break
        if n in position:
            region = frame[box['y']: box['y'] + bh, box['x']: box['x'] + bw]
            transforms[position[n]] = estimate(orb, matcher, region, clip.get(pick[position[n]]), mask)
    matched = sum(t is not None for t in transforms)
    smoothed = smooth(transforms)
    if smoothed is None:
        # No background match anywhere: stretch over the box as before.
        smoothed = [np.array([[1, 0, 0], [0, bh / scaled_h, 0]], np.float32)] * len(targets)
    edge = feather(bh, bw, box, frame_w, frame_h)
    ones = np.ones((scaled_h, bw), np.float32)
    kernel = np.ones((7, 7), np.uint8)

    encoder = subprocess.Popen(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
         '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{frame_w}x{frame_h}', '-r', str(fps), '-i', '-',
         '-i', video, '-map', '0:v', '-map', '1:a?', '-c:a', 'copy',
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output],
        stdin=subprocess.PIPE,
    )
    capture = cv2.VideoCapture(video)
    clip = PatchReader(patch_path, bw)
    for n in range(total):
        ok, frame = capture.read()
        if not ok:
            break
        if n in position:
            i = position[n]
            transform = smoothed[i]
            warped = cv2.warpAffine(clip.get(pick[i]), transform, (bw, bh), flags=cv2.INTER_LINEAR, borderValue=0)
            cover = cv2.warpAffine(ones, transform, (bw, bh), flags=cv2.INTER_LINEAR, borderValue=0)
            cover = cv2.GaussianBlur(cv2.erode(cover, kernel), (0, 0), 4)
            alpha = (edge * cover)[..., None]
            region = frame[box['y']: box['y'] + bh, box['x']: box['x'] + bw].astype(np.float32)
            frame[box['y']: box['y'] + bh, box['x']: box['x'] + bw] = (warped * alpha + region * (1 - alpha)).astype(np.uint8)
        encoder.stdin.write(frame.tobytes())
    encoder.stdin.close()
    if encoder.wait() != 0:
        raise SystemExit('encode failed')
    print(json.dumps({'frames': len(targets), 'matched': matched}))


if __name__ == '__main__':
    main()
