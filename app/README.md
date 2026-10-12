# niCode app

The phone app for niCode (Expo SDK 57, React Native, expo-router). Specification and status:
[docs/04-APP-BLUEPRINT.md](../docs/04-APP-BLUEPRINT.md).

```bash
npm install
npm run typecheck && npm run lint
npm run build:apk          # → android/app/build/outputs/apk/release/app-release.apk
npx expo run:android       # dev build on an emulator / USB phone (live reload)
```

Structure: routes in `src/app/` (pairing, servers, projects, the Chat / Files / Changes / Terminal
tabs), shared UI in `src/components/`, connection + device key in `src/lib/`, state in `src/state/`.
The wire contract is imported from `../protocol/types.ts` as `@protocol`.
