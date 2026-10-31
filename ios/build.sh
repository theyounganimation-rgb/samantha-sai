#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodegen generate
xcodebuild -project SAI.xcodeproj -scheme SAI -configuration Release -destination 'generic/platform=iOS' -derivedDataPath /private/tmp/sai-ios-build -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
