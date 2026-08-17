# Release and installation

## Install on a new computer

1. Download `hi-auto-browser-helper.zip` and `hi-auto-browser-helper.sha256` from the latest GitHub release.
2. Verify SHA-256, then extract the ZIP.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the extracted `hi-auto-browser-helper` directory.
4. Start `HiAuto_LocalAgent` on the computer.
5. In Hi Auto Cloud, choose **Máy & công việc → Tạo mã ghép Extension**.
6. Open the Extension Side Panel, enter the six-digit code, and choose **Ghép Agent**.

## Publish

The GitHub workflow tests and builds every push. Pushing a tag such as `v3.0.0` also creates a GitHub Release containing the ZIP and SHA-256 checksum.
