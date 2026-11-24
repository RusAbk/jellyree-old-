#!/usr/bin/env bash
set -euo pipefail

bundle_id=app.jellyree.mobile

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

for setting in IOS_BUILD_CERTIFICATE_BASE64 IOS_BUILD_CERTIFICATE_PASSWORD IOS_PROVISIONING_PROFILE_BASE64 IOS_IPA_RECIPIENT; do
  [[ -n "${!setting:-}" ]] || fail "Configure $setting in the ios-device GitHub environment."
done

[[ "$IOS_IPA_RECIPIENT" =~ ^age1[0-9a-z]+$ ]] || fail 'IOS_IPA_RECIPIENT must be an age public key (age1…).'
if [[ "${1:-}" == --check ]]; then
  exit
fi

[[ "$(uname -s)" == Darwin ]] || fail 'Building an iPhone IPA requires macOS and Xcode.'
cd "$(dirname "$0")/.."
command -v age >/dev/null || fail 'Install age before building the IPA.'

signing_config=ios/Flutter/DeviceSigning.xcconfig
[[ ! -e "$signing_config" ]] || fail "Move the existing $signing_config before building."
umask 077
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/jellyree-signing.XXXXXXXX")
keychain="$scratch/signing.keychain-db"
profile_path=''
keychains=("$keychain")
changed_keychains=false
cleanup() {
  if $changed_keychains; then
    if (( ${#keychains[@]} > 1 )); then
      security list-keychains -d user -s "${keychains[@]:1}" >/dev/null 2>&1 || true
    else
      security list-keychains -d user -s >/dev/null 2>&1 || true
    fi
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  if [[ -n "$profile_path" ]]; then
    rm -f "$profile_path"
  fi
  rm -f "$signing_config"
  rm -rf "$scratch"
}
trap cleanup EXIT

python3 - "$scratch" <<'PY'
import base64
import os
import sys
from pathlib import Path

folder = Path(sys.argv[1])
for variable, filename in (
    ("IOS_BUILD_CERTIFICATE_BASE64", "certificate.p12"),
    ("IOS_PROVISIONING_PROFILE_BASE64", "app.mobileprovision"),
):
    value = "".join(os.environ[variable].split())
    try:
        data = base64.b64decode(value, validate=True)
        if not data:
            raise ValueError()
    except ValueError:
        sys.exit(f"{variable} must contain the base64 encoding of the entire file.")
    (folder / filename).write_bytes(data)
PY
unset IOS_BUILD_CERTIFICATE_BASE64 IOS_PROVISIONING_PROFILE_BASE64

security cms -D -i "$scratch/app.mobileprovision" -o "$scratch/profile.plist"
python3 - "$scratch" "$bundle_id" <<'PY'
import datetime
import hashlib
import plistlib
import re
import sys
from pathlib import Path

folder = Path(sys.argv[1])
bundle = sys.argv[2]
with (folder / "profile.plist").open("rb") as file:
    profile = plistlib.load(file)

entitlements = profile.get("Entitlements", {})
if (
    not profile.get("ProvisionedDevices")
    or profile.get("ProvisionsAllDevices")
    or entitlements.get("get-task-allow") is not False
):
    sys.exit("Provide an Apple Ad Hoc provisioning profile for registered devices.")
if entitlements.get("application-identifier", "").partition(".")[2] != bundle:
    sys.exit(f"The provisioning profile must be for {bundle}.")
expires = profile.get("ExpirationDate")
if not isinstance(expires, datetime.datetime) or (
    expires.replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc)
):
    sys.exit("The provisioning profile has expired.")
team = next(iter(profile.get("TeamIdentifier", [])), "")
uuid = profile.get("UUID", "")
if not re.fullmatch(r"[A-Z0-9]{10}", team) or not re.fullmatch(
    r"[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", uuid
):
    sys.exit("The provisioning profile does not contain a valid team ID and UUID.")

(folder / "team").write_text(team)
(folder / "uuid").write_text(uuid)
(folder / "certificates").write_text(
    "\n".join(hashlib.sha1(cert).hexdigest().upper() for cert in profile["DeveloperCertificates"]) + "\n"
)
PY

security list-keychains -d user > "$scratch/keychains"
while IFS= read -r path; do
  path="${path#*\"}"
  keychains+=("${path%\"}")
done < "$scratch/keychains"

keychain_password=$(openssl rand -hex 32)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$scratch/certificate.p12" -k "$keychain" \
  -P "$IOS_BUILD_CERTIFICATE_PASSWORD" -f pkcs12 -T /usr/bin/codesign >/dev/null
unset IOS_BUILD_CERTIFICATE_PASSWORD
rm -f "$scratch/certificate.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
unset keychain_password
security list-keychains -d user -s "${keychains[@]}"
changed_keychains=true

identity=$(security find-identity -v -p codesigning "$keychain" |
  awk 'NR == FNR { allowed[$1] = 1; next }
       /"Apple Distribution:/ && allowed[$2] && !found { print $2; found = 1 }' "$scratch/certificates" -)
[[ -n "$identity" ]] || fail 'The certificate must be an Apple Distribution signing identity present in the provisioning profile.'

team=$(cat "$scratch/team")
uuid=$(cat "$scratch/uuid")
profile_dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profile_dir"
[[ ! -e "$profile_dir/$uuid.mobileprovision" ]] || fail 'This provisioning profile is already installed on the runner.'
profile_path="$profile_dir/$uuid.mobileprovision"
cp "$scratch/app.mobileprovision" "$profile_path"

cat > "$signing_config" <<EOF
CODE_SIGN_STYLE = Manual
DEVELOPMENT_TEAM = $team
CODE_SIGN_IDENTITY[sdk=iphoneos*] = $identity
PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*] = $uuid
EOF

python3 - "$scratch/export.plist" "$bundle_id" "$team" "$uuid" "$identity" <<'PY'
import plistlib
import sys

path, bundle, team, uuid, identity = sys.argv[1:]
with open(path, "wb") as file:
    plistlib.dump({
        "method": "release-testing",
        "destination": "export",
        "signingStyle": "manual",
        "signingCertificate": identity,
        "teamID": team,
        "provisioningProfiles": {bundle: uuid},
    }, file)
PY

flutter build ios --config-only --release --no-pub --build-number "${GITHUB_RUN_NUMBER:-1}"
xcodebuild archive -workspace ios/Runner.xcworkspace -scheme Runner \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$scratch/Jellyree.xcarchive"
xcodebuild -exportArchive -archivePath "$scratch/Jellyree.xcarchive" \
  -exportOptionsPlist "$scratch/export.plist" -exportPath "$scratch/export"

shopt -s nullglob
ipa=("$scratch/export/"*.ipa)
[[ ${#ipa[@]} == 1 ]] || fail 'Xcode did not export exactly one IPA.'
mkdir -p build/iphone
age --encrypt --recipient "$IOS_IPA_RECIPIENT" --output "$scratch/Jellyree.ipa.age" "${ipa[0]}"
mv "$scratch/Jellyree.ipa.age" build/iphone/Jellyree.ipa.age
