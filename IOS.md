# 📱 EnergyGame na iPhonu

## Varianta 1: PWA – funguje hned, bez čehokoliv

1. Na iPhonu otevři v **Safari** adresu hry
   (např. `http://ais-macbook-pro.tailaaef09.ts.net:8000` – iPhone musí být
   ve stejném tailnetu, nebo veřejnou GitHub Pages adresu).
2. **Sdílet → Přidat na plochu.**
3. Na ploše přibude ikona EnergyGame; hra se spouští celoobrazovkově
   na šířku a díky service workeru funguje i offline.

## Varianta 2: Nativní aplikace (Capacitor)

Repozitář obsahuje hotový Xcode projekt v `ios/` (Capacitor 7, závislosti
přes Swift Package Manager – CocoaPods nejsou potřeba). Webové assety se
do projektu skládají příkazem:

```bash
npm install
npm run ios:sync   # build:web (složí www/) + npx cap sync ios
```

### Co je potřeba jednorázově udělat (vyžaduje Apple ID / admin práva)

1. **Nainstalovat Xcode** z App Storu (zdarma, ~30 GB) a potvrdit:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   ```

2. Otevřít projekt:

   ```bash
   open ios/App/App.xcodeproj
   ```

3. V **Signing & Capabilities** vybrat svůj tým (stačí bezplatné Apple ID –
   Xcode → Settings → Accounts). Bundle ID: `cz.mirapavlicek.energygame`.
4. Připojit iPhone kabelem, povolit **Developer Mode**
   (Nastavení → Soukromí a zabezpečení → Režim pro vývojáře) a dát **Run** (⌘R).

S bezplatným účtem podpis platí 7 dní (pak znovu Run). Pro TestFlight /
App Store je potřeba Apple Developer Program (99 USD/rok).

### Simulátor (bez podpisu)

```bash
cd ios/App
xcodebuild -project App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  CODE_SIGNING_ALLOWED=NO build
```

### Poznámky

- Hra má dotykové ovládání (tažení, pinch zoom, ťuknutí) a safe-area
  odsazení pro notch/Dynamic Island; orientace je zamčená na šířku.
- Service worker se v nativní aplikaci neregistruje (assety jsou lokální).
- Po změně hry stačí `npm run ios:sync` a Run v Xcode.
