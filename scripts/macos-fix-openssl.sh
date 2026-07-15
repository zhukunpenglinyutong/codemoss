#!/usr/bin/env bash
set -euo pipefail

app_path="${1:-src-tauri/target/release/bundle/macos/CodePort.app}"
identity="${CODESIGN_IDENTITY:-}"
entitlements_path="${ENTITLEMENTS_PATH:-src-tauri/Entitlements.plist}"

if [[ -z "${identity}" ]]; then
  echo "CODESIGN_IDENTITY is required. Example:"
  echo "  CODESIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)' $0"
  exit 1
fi

if [[ ! -d "${app_path}" ]]; then
  echo "App bundle not found: ${app_path}"
  exit 1
fi

codesign_entitlements=()
if [[ -f "${entitlements_path}" ]]; then
  echo "Using entitlements: ${entitlements_path}"
  codesign_entitlements=(--entitlements "${entitlements_path}")
else
  echo "Warning: entitlements file not found at ${entitlements_path}; signing without entitlements."
fi

openssl_prefix=""
if command -v brew >/dev/null 2>&1; then
  openssl_prefix="$(brew --prefix openssl@3 2>/dev/null || true)"
fi
if [[ -z "${openssl_prefix}" ]]; then
  if [[ -d "/opt/homebrew/opt/openssl@3" ]]; then
    openssl_prefix="/opt/homebrew/opt/openssl@3"
  elif [[ -d "/usr/local/opt/openssl@3" ]]; then
    openssl_prefix="/usr/local/opt/openssl@3"
  fi
fi

if [[ -z "${openssl_prefix}" ]]; then
  echo "OpenSSL@3 not found. Install it with Homebrew first."
  exit 1
fi

libssl="${openssl_prefix}/lib/libssl.3.dylib"
libcrypto="${openssl_prefix}/lib/libcrypto.3.dylib"
frameworks_dir="${app_path}/Contents/Frameworks"
bin_path="${app_path}/Contents/MacOS/cc-gui"
daemon_path="${app_path}/Contents/MacOS/cc_gui_daemon"

if [[ ! -f "${libssl}" || ! -f "${libcrypto}" ]]; then
  echo "OpenSSL dylibs not found at ${openssl_prefix}/lib"
  exit 1
fi

mkdir -p "${frameworks_dir}"
cp -f "${libssl}" "${frameworks_dir}/"
cp -f "${libcrypto}" "${frameworks_dir}/"

install_name_tool -id "@rpath/libssl.3.dylib" "${frameworks_dir}/libssl.3.dylib"
install_name_tool -id "@rpath/libcrypto.3.dylib" "${frameworks_dir}/libcrypto.3.dylib"

# Dynamically discover and fix libssl's reference to libcrypto
crypto_ref=$(otool -L "${frameworks_dir}/libssl.3.dylib" | grep 'libcrypto' | awk '{print $1}')
if [[ -n "${crypto_ref}" && "${crypto_ref}" != "@rpath/libcrypto.3.dylib" ]]; then
  echo "Fixing libssl -> libcrypto reference: ${crypto_ref}"
  install_name_tool -change "${crypto_ref}" "@rpath/libcrypto.3.dylib" "${frameworks_dir}/libssl.3.dylib"
fi

# Fix binary references dynamically
for bin in "${bin_path}" "${daemon_path}"; do
  [[ -f "${bin}" ]] || continue

  ssl_ref=$(otool -L "${bin}" | grep 'libssl' | awk '{print $1}')
  if [[ -n "${ssl_ref}" && "${ssl_ref}" != "@rpath/libssl.3.dylib" ]]; then
    echo "Fixing $(basename "${bin}") -> libssl reference: ${ssl_ref}"
    install_name_tool -change "${ssl_ref}" "@rpath/libssl.3.dylib" "${bin}"
  fi

  crypto_ref=$(otool -L "${bin}" | grep 'libcrypto' | awk '{print $1}')
  if [[ -n "${crypto_ref}" && "${crypto_ref}" != "@rpath/libcrypto.3.dylib" ]]; then
    echo "Fixing $(basename "${bin}") -> libcrypto reference: ${crypto_ref}"
    install_name_tool -change "${crypto_ref}" "@rpath/libcrypto.3.dylib" "${bin}"
  fi

  if ! otool -l "${bin}" | grep -q "@executable_path/../Frameworks"; then
    install_name_tool -add_rpath "@executable_path/../Frameworks" "${bin}"
  fi
done

# Verify all references are fixed
echo "Verifying library references..."
verify_failed=0
for lib in "${frameworks_dir}/libssl.3.dylib" "${frameworks_dir}/libcrypto.3.dylib"; do
  if otool -L "${lib}" | grep -v '@rpath' | grep -q '/opt/\|/usr/local/'; then
    echo "ERROR: ${lib} still has absolute references:"
    otool -L "${lib}" | grep '/opt/\|/usr/local/'
    verify_failed=1
  fi
done
for bin in "${bin_path}" "${daemon_path}"; do
  [[ -f "${bin}" ]] || continue
  if otool -L "${bin}" | grep -E 'libssl|libcrypto' | grep -v '@rpath' | grep -q '/opt/\|/usr/local/'; then
    echo "ERROR: ${bin} still has absolute references:"
    otool -L "${bin}" | grep -E 'libssl|libcrypto' | grep '/opt/\|/usr/local/'
    verify_failed=1
  fi
done
if [[ ${verify_failed} -eq 1 ]]; then
  echo "ERROR: Library reference fixup incomplete. Aborting."
  exit 1
fi
echo "All library references verified OK."

codesign --force --options runtime --timestamp --sign "${identity}" "${frameworks_dir}/libcrypto.3.dylib"
codesign --force --options runtime --timestamp --sign "${identity}" "${frameworks_dir}/libssl.3.dylib"
codesign --force --options runtime --timestamp --sign "${identity}" "${codesign_entitlements[@]}" "${bin_path}"
if [[ -f "${daemon_path}" ]]; then
  codesign --force --options runtime --timestamp --sign "${identity}" "${codesign_entitlements[@]}" "${daemon_path}"
fi
codesign --force --options runtime --timestamp --sign "${identity}" "${codesign_entitlements[@]}" "${app_path}"

echo "Bundled OpenSSL dylibs and re-signed ${app_path}"
