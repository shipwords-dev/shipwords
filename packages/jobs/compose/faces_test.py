"""Frame reading of faces.py on outputs shaped like Kling 4.0 Edit's: audio track first, video time base 1/12288, P-frames only with
keyframes at frames 0 and 330, and decode times 4 frames ahead of presentation (first video packet pts 0, dts -2048). OpenCV's frame seek
on such a file returns frame 1 for every index from 18 to 342, so the swap check never saw the close-ups (2026-11-22: an unswapped
saxophone player scored 0.1 instead of 0.75). Every frame read must equal the one decoded in order.

Run in the compose image (it has ffmpeg, OpenCV and the face models faces.py loads on import):
  docker run --rm -v "$PWD/packages/jobs/compose:/t" --entrypoint python3 shipwords-compose /t/faces_test.py
"""
import os
import subprocess
import sys
import tempfile

import cv2
import numpy

sys.path.insert(0, '/app')
import faces  # noqa: E402


def sequential(path):
    capture = cv2.VideoCapture(path)
    result = []
    while True:
        ok, image = capture.read()
        if not ok:
            return result
        result.append(image)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'sparse.mp4')
        # A moving pattern with a frame counter, so every frame differs, muxed like the Kling output (see above).
        subprocess.run(
            ['ffmpeg', '-v', 'error',
             '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=18',
             '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=18',
             '-map', '0:a', '-map', '1:v', '-c:a', 'aac',
             '-c:v', 'libx264', '-profile:v', 'main', '-bf', '0', '-g', '330', '-keyint_min', '330', '-sc_threshold', '0',
             '-pix_fmt', 'yuv420p', '-video_track_timescale', '12288', '-bsf:v', 'setts=dts=DTS-2048', path],
            check=True,
        )
        truth = sequential(path)
        assert len(truth) == 432, len(truth)

        indices = [12, 150, 280, 290, 329, 330, 331, 400, 150]
        read = faces.read_frames(path, indices)
        assert sorted(read) == sorted(set(indices)), sorted(read)
        for index in set(indices):
            assert numpy.array_equal(read[index], truth[index]), f'frame {index} is not the frame decoded in order'

        sampled = faces.frames(path, 18, 36)
        assert len(sampled) == 36, len(sampled)
        for image, at in sampled:
            index = round(at * 24)
            assert numpy.array_equal(image, truth[index]), f'frames() at {at:.2f}s is not frame {index}'
            assert at < 18

        # keep runs on each decoded frame; only its result is held.
        shapes = faces.read_frames(path, [5, 200], keep=lambda image: image.shape)
        assert shapes == {5: truth[5].shape, 200: truth[200].shape}, shapes

        # Indices past the end are left out, not filled with another frame.
        assert sorted(faces.read_frames(path, [10, 431, 432, 5000])) == [10, 431], 'past-the-end indices'

        # A decode that stops halfway (a broken frame) still reads the indices after it, by seeking, instead of dropping them.
        real = cv2.VideoCapture

        class Broken:
            def __init__(self, *args):
                self.capture, self.grabs = real(*args), 0

            def grab(self):
                self.grabs += 1
                return False if self.grabs == 101 else self.capture.grab()

            def __getattr__(self, name):
                return getattr(self.capture, name)

        faces.cv2.VideoCapture = Broken
        try:
            after = faces.read_frames(path, [20, 150, 400])
        finally:
            faces.cv2.VideoCapture = real
        assert sorted(after) == [20, 150, 400], sorted(after)
        assert numpy.array_equal(after[20], truth[20])
    print('faces_test: ok')


if __name__ == '__main__':
    main()
