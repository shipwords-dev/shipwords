# Effect video compose container: Node + ffmpeg for stitching, Python + OpenCV for the swap check (faces.py). Listens on 8080.
# Python base (has CA certificates and pip) with Node copied in; apt uses HTTPS mirrors.
FROM python:3.12-slim-bookworm
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir opencv-python-headless==4.11.0.86 numpy==2.2.6
WORKDIR /app
# OpenCV Zoo face detection (YuNet) and recognition (SFace), pinned by checksum.
ADD --checksum=sha256:8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4 \
  https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx models/yunet.onnx
ADD --checksum=sha256:0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79 \
  https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx models/sface.onnx
COPY compose.mjs server.mjs faces.py align.py ./
EXPOSE 8080
CMD ["node", "server.mjs"]
