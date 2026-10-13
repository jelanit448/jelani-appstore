# node:24-slim (Debian/glibc) — NOT alpine. Android build-tools are glibc
# binaries and segfault under Alpine's musl. AppMaker needs a working JDK +
# Android SDK in the image to compile APKs on the server.
FROM node:24-slim
WORKDIR /app

# JDK for javac/keytool/d8
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless unzip curl zip \
    && rm -rf /var/lib/apt/lists/*

# Android SDK: cmdline-tools, then platform android-36 + build-tools 35.0.0
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
RUN mkdir -p $ANDROID_HOME/cmdline-tools && \
    curl -fsSL -o /tmp/cmdtools.zip \
      https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && \
    unzip -q /tmp/cmdtools.zip -d $ANDROID_HOME/cmdline-tools && \
    mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && \
    rm /tmp/cmdtools.zip && \
    yes | sdkmanager --licenses > /dev/null && \
    sdkmanager "platforms;android-36" "build-tools;35.0.0" "platform-tools"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# data/ (SQLite + AppMaker debug keystore) and uploads/ (APKs) must persist —
# mount a volume in production
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
CMD ["node", "server.js"]
