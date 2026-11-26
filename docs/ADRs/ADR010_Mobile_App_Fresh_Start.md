# ADR-010: Mobile App Fresh Start with Minimal Expo

**Status:** Accepted
**Date:** 2025-02-07
**Accepted-on-dev:** 2025-02-07
**Deciders:** Angus Hally
**Tags:** mobile, react-native, expo, ignite, architecture

## Context

The current mobile app at `packages/mobile/` was created using the Ignite boilerplate (from Infinite Red). While Ignite provides a comprehensive starting point, it has introduced significant issues:

### Current State

- **Tech Stack:** Expo SDK 54, React Native 0.81.5, Ignite boilerplate
- **Package Manager Conflict:** Mobile uses Yarn 4 while monorepo uses npm workspaces
- **File Count:** ~115 TypeScript files in `app/` directory
- **Business Logic:** ~15 files (~1,700 lines) of actual app-specific code
- **Boilerplate:** ~70 files (~8,000+ lines) of demo screens, showcase components, and unused code

### Problems Identified

1. **Metro bundler crashes** - Tries to watch root `node_modules` which doesn't exist due to npm workspaces
2. **Package manager mismatch** - Yarn 4 (mobile) vs npm (monorepo) causes structural conflicts
3. **Excessive boilerplate:**
   - 13 files in `DemoShowroomScreen/` for component demos
   - Demo screens: `DemoCommunityScreen`, `DemoDebugScreen`, `DemoPodcastListScreen`
   - `EpisodeContext.tsx` for podcast demo data
   - 7 `demo-*.ts` i18n files + 6 unused language files
   - Reactotron devtools setup (3 files)
   - Complex theme system (11 files)
   - Unused API service layer (apisauce-based, 4 files)
4. **Maintenance burden** - 82% of code is boilerplate, 18% is actual app logic

### Business Logic Worth Preserving

Analysis of commit history (bc1a56b onwards) identified the following custom code:

| File | Lines | Purpose |
|------|-------|---------|
| `services/artifacts/artifactService.ts` | 133 | Worker `/api/upload` integration |
| `services/artifacts/offlineQueue.ts` | 105 | Local queue for offline captures |
| `services/artifacts/syncService.ts` | ~100 | Queue synchronization |
| `services/shareIntent/shareIntentHandler.ts` | 227 | Android share intent handling |
| `services/shareIntent/shareIntentService.ts` | ~50 | Share intent utilities |
| `services/supabase/*.ts` | ~80 | Supabase client and auth helpers |
| `services/auth/google.ts` | ~40 | Google OAuth configuration |
| `context/AuthContext.tsx` | ~150 | Authentication state management |
| `hooks/useNetworkStatus.ts` | ~40 | Network connectivity detection |
| `hooks/useSyncQueue.ts` | ~60 | Sync queue hook |
| `screens/QuickCaptureScreen.tsx` | 272 | Main capture UI |
| `screens/HomeScreen.tsx` | 134 | Home screen |
| `screens/ShareIntentScreen.tsx` | ~150 | Share intent UI |
| `screens/Login/SignUp/ForgotPassword` | ~400 | Authentication screens |

**Total:** ~1,700 lines of reusable business logic

## Decision

**Start fresh with a minimal Expo setup and migrate the existing business logic.**

### Approach

1. **Archive current mobile package** - Move to `.ZZarchive/packages-mobile-ignite/` for reference
2. **Create new minimal Expo app** - Use `npx create-expo-app` with TypeScript template
3. **Use npm** - Consistent with monorepo (no Yarn)
4. **Migrate business logic** - Copy the ~1,700 lines of custom code
5. **Use Expo Router** - Modern file-based routing (simpler than React Navigation setup)
6. **Minimal dependencies** - Only what's needed, add incrementally

### New Package Structure

```
packages/mobile/
├── app/                    # Expo Router file-based routes
│   ├── (auth)/            # Auth group (login, signup, forgot-password)
│   ├── (app)/             # Authenticated app group
│   │   ├── index.tsx      # Home/Dashboard
│   │   ├── capture.tsx    # Quick capture
│   │   └── ...
│   ├── _layout.tsx        # Root layout
│   └── +not-found.tsx     # 404
├── components/            # Minimal UI components
├── services/              # Migrated from current app
│   ├── artifacts/         # artifactService, offlineQueue, syncService
│   ├── supabase/          # Supabase client, auth
│   └── shareIntent/       # Share intent handling
├── hooks/                 # useNetworkStatus, useSyncQueue
├── context/               # AuthContext
├── package.json           # npm, not yarn
└── app.json              # Expo config
```

## Consequences

### Positive

- **Consistent package manager** - npm throughout monorepo
- **Metro works** - Proper monorepo configuration from start
- **~80% less code** - Only business logic, no boilerplate
- **Modern routing** - Expo Router is simpler than React Navigation manual setup
- **Easier maintenance** - Less code = fewer bugs, easier to understand
- **Clean dependencies** - Only install what's needed

### Negative

- **Migration effort** - Need to recreate screens with new structure
- **Lost Ignite components** - Need simpler alternatives (or use libraries like Tamagui, NativeWind)
- **Theme system** - Need simpler approach (could use NativeWind/Tailwind)
- **Time investment** - ~2-4 hours for initial setup + migration

### Neutral

- Feature requirements unchanged (Phase 5 checklist still applies)
- Business logic is already well-structured and portable
- Can add component library later if needed

## Alternatives Considered

### Alternative 1: Fix Metro Config in Current Setup

- **Pros:** No migration, keeps existing code
- **Cons:** Doesn't fix Yarn/npm mismatch, still carries 8,000 lines of boilerplate, Metro config for monorepos is complex

### Alternative 2: Remove Boilerplate from Current App

- **Pros:** Keeps current structure, incremental cleanup
- **Cons:** Yarn/npm mismatch remains, complex to untangle Ignite dependencies, theme system deeply integrated

### Alternative 3: Use Different Boilerplate (e.g., create-expo-app with tabs)

- **Pros:** Less boilerplate than Ignite
- **Cons:** Still adds unnecessary demo code, better to start truly minimal

## Migration Checklist

### Phase 5.0: Fresh Start Setup

- [ ] Archive current mobile package to `.ZZarchive/packages-mobile-ignite/`
- [ ] Create new Expo app: `npx create-expo-app@latest packages/mobile --template blank-typescript`
- [ ] Configure for monorepo (metro.config.js with proper watchFolders)
- [ ] Add workspace dependency: `"@ahkms/shared": "*"` to package.json
- [ ] Verify `npm run dev:mobile` works from root

### Phase 5.0.1: Core Dependencies

- [ ] Install Supabase: `@supabase/supabase-js`, `@react-native-async-storage/async-storage`
- [ ] Install Expo Router: `expo-router`, `expo-linking`, `expo-constants`
- [ ] Install essentials: `expo-secure-store`, `expo-image-picker`, `expo-document-picker`
- [ ] Install network: `@react-native-community/netinfo`

### Phase 5.0.2: Migrate Business Logic

- [ ] Copy `services/supabase/` (supabase client, auth helpers)
- [ ] Copy `services/artifacts/` (artifactService, offlineQueue, syncService)
- [ ] Copy `services/shareIntent/` (shareIntentHandler, shareIntentService)
- [ ] Copy `context/AuthContext.tsx` (adapt for Expo Router)
- [ ] Copy `hooks/` (useNetworkStatus, useSyncQueue)

### Phase 5.0.3: Recreate Screens

- [ ] Create `app/_layout.tsx` with auth check
- [ ] Create `app/(auth)/login.tsx` from LoginScreen
- [ ] Create `app/(auth)/signup.tsx` from SignUpScreen
- [ ] Create `app/(app)/index.tsx` from HomeScreen
- [ ] Create `app/(app)/capture.tsx` from QuickCaptureScreen
- [ ] Create share intent handling

## References

- Expo Router docs: https://docs.expo.dev/router/introduction/
- Current mobile package: `packages/mobile/` (to be archived)
- Implementation Plan Phase 5: `docs/design/architecture/Implementation_Plan.md`
- Monorepo with Expo: https://docs.expo.dev/guides/monorepos/
