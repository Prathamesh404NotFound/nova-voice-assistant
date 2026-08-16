# Nova — Code Signing Guide

Nova ships **unsigned** builds by default. An unsigned installer works, but
Windows SmartScreen and macOS Gatekeeper will warn the user ("unverified
developer"). Signing removes those warnings.

## Windows (nsis, x64)

electron-builder uses `signtool` under the hood. Two supported paths:

1. **EV code-signing certificate (recommended)**
   - Buy an EV certificate (DigiCert, Sectigo, …). It is stored on a
     hardware token or in the cloud (DigiCert Keylocker / Sectigo Cloud).
   - Set environment variables before building:
     `CSC_LINK=file:///path/to/certificate.p12` and `CSC_KEY_PASSWORD=…`
     (or the cloud provider's variables — see the electron-builder docs).
   - `npx electron-builder --win nsis` then produces a signed `Nova Setup.exe`.

2. **Regular (non-EV) certificate**
   - Works the same way, but SmartScreen may still warn until the
     certificate builds reputation.

To enable signing, add to `build.win` in `package.json`:
```json
"win": { "certificateFile": "cert.p12", "certificatePassword": "${CERT_PASSWORD}" }
```
Prefer `CSC_LINK`/`CSC_KEY_PASSWORD` env vars over baking secrets into the file.

## macOS (.dmg)

Signing requires an Apple Developer ID certificate from a paid Apple
Developer account:

1. In Xcode: Settings → Accounts → Manage Certificates → create
   "Developer ID Application".
2. Build with the identity name:
   ```
   CSC_IDENTITY_AUTO_DISCOVERY=true npx electron-builder --mac dmg      -c.mac.identity="Developer ID Application: Your Name (TEAMID)"
   ```
3. **Notarize** after signing (required on modern macOS):
   - Upload with `xcrun notarytool submit Nova-x.x.x.dmg --apple-id …`
   - Or set in `build.mac`: `"hardenedRuntime": true` plus electron-builder's
     automatic notarization using `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
     and `APPLE_TEAM_ID` env vars.

The free-tier distribution (GitHub releases, unsigned) remains available:
users can right-click → Open to bypass Gatekeeper once.

## CI signing

Add the cert secrets as repository secrets and pass them through:
```yaml
env:
  CSC_LINK: ${{ secrets.WIN_CERT }}
  CSC_KEY_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_ASP }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```
