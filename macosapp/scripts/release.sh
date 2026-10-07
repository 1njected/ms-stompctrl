#!/bin/bash
# Build a self-contained, universal, ad-hoc-signed preview for GitHub Releases.
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
version=${1:-0.1.0}
build_number=${2:-1}
output_dir=${3:-"$repo_dir/macosapp/build/release"}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Version must be X.Y.Z' >&2; exit 2; }
[[ "$build_number" =~ ^[1-9][0-9]*$ ]] || { echo 'Build number must be a positive integer' >&2; exit 2; }
command -v xcodegen >/dev/null || { echo 'Install XcodeGen: brew install xcodegen' >&2; exit 2; }
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
stage_dir=$(mktemp -d /tmp/stomp-release.XXXXXX)
# Stage only public frontend files tracked by Git. Never bundle ignored effect
# binaries, artwork, captures, backups, or a developer's local fixtures.
python3 - "$repo_dir" "$stage_dir" <<'PY'
import pathlib, shutil, subprocess, sys
repo, stage = map(pathlib.Path, sys.argv[1:])
(stage / 'app').mkdir()
files = subprocess.check_output(['git', '-C', str(repo), 'ls-files', '-z', 'app']).decode().split('\0')
for name in filter(None, files):
    source = repo / name
    if source.parent == repo / 'app' and source.suffix in {'.js', '.html', '.css', '.json', '.png', '.py'}:
        if source.is_symlink():
            raise SystemExit(f'Refusing symlink: {name}')
        shutil.copy2(source, stage / name)
for directory in ['Sources', 'web']:
    shutil.copytree(repo / 'macosapp' / directory, stage / 'macosapp' / directory)
shutil.copy2(repo / 'macosapp/project.yml', stage / 'macosapp/project.yml')
PY
xcodegen generate --spec "$stage_dir/macosapp/project.yml"
xcodebuild -project "$stage_dir/macosapp/StompCtrlMac.xcodeproj" -scheme StompCtrlMac \
  -configuration Release -derivedDataPath "$stage_dir/DerivedData" \
  ARCHS='arm64 x86_64' ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build_number" build > "$output_dir/build.log" 2>&1 || {
    tail -60 "$output_dir/build.log"; exit 1;
  }
package_dir="$stage_dir/MS-StompCtrl"
mkdir -p "$package_dir"
app_path="$package_dir/StompCtrlMac.app"
ditto "$stage_dir/DerivedData/Build/Products/Release/StompCtrlMac.app" "$app_path"
# Apple Silicon requires a code signature. Ad-hoc signing is not Developer ID
# signing and does not make this a notarized/trusted Internet download.
codesign --force --sign - --timestamp=none "$app_path"
codesign --verify --deep --strict "$app_path"
architectures=$(lipo -archs "$app_path/Contents/MacOS/StompCtrlMac")
for architecture in arm64 x86_64; do
  [[ " $architectures " == *" $architecture "* ]] || { echo "Missing architecture: $architecture" >&2; exit 1; }
done
cp "$repo_dir/LICENSE" "$repo_dir/NOTICE.md" "$package_dir/"
cp "$repo_dir/macosapp/RELEASE-NOTES.md" "$package_dir/README.md"
archive="MS-StompCtrl-macOS-$version-universal.zip"
ditto -c -k --sequesterRsrc --keepParent "$package_dir" "$output_dir/$archive"
(cd "$output_dir" && shasum -a 256 "$archive" > "$archive.sha256")
printf 'Release archive: %s\nStaging directory: %s\n' "$output_dir/$archive" "$stage_dir"
