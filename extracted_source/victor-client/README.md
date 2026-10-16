# Reconstructed VICTOR AI client

This project preserves the recovered VICTOR HTML/CSS/JavaScript interface and wraps it in a generated Capacitor Android project. The package ID remains `ai.victor.secretary`; provider secrets and production server URLs are not embedded.

## Build

```bash
npm install
npm run copy-web
npx cap sync android
cd android
./gradlew assembleDebug assembleRelease
```

The Android project has been compiled successfully in this workspace. The generated release artifact is unsigned by Gradle. For a test-installable build, sign it with a key you control:

```bash
$ANDROID_HOME/build-tools/35.0.0/apksigner sign \
  --ks /path/to/your-release-key.jks \
  --out app-release-signed.apk app-release-unsigned.apk
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --verbose app-release-signed.apk
```

A test-signed APK built in this workspace is provided separately. It is suitable for installation/testing, but its debug test key must not be used as a production signing identity.

## Configure and run

Install the APK, open its server settings, and enter the deployed HTTPS backend URL. The backend PIN and provider credentials belong on the server, never in this project or APK. Microphone permission is declared in the manifest and is requested by the recovered voice flow at runtime.
