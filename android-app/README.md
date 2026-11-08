# Pluralsight Offline – Android companion

A small native WebView app for the local Pluralsight Offline portal.

- Phone and Android TV
- Leanback launcher and TV banner
- D-pad navigation and focus outlines
- Fullscreen video
- Configurable server address

## Build

Requirements:

- JDK 17
- Android SDK with platform 34 and build-tools 34.0.0
- Gradle 8.9+

```bash
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=/path/to/Android/Sdk
gradle -p android-app assembleDebug
```

The APK is written to:

```
android-app/app/build/outputs/apk/debug/app-debug.apk
```

Install it manually on the phone or TV. On first launch, tap the gear button and enter your portal address, for example:

```
http://192.168.1.100:4545
```

The default is a placeholder and must be changed to your PC's LAN IP.

## Note

Jellyfin is the recommended app for watching courses on Android and Android TV. This companion app is mainly useful for the local portal, labs, exams, notes and search.
