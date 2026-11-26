# ADR-003: Standardizing Directory Names

**Status:** Superseded by Monorepo Migration (December 2025)  
**Date:** 2025-12-24  
**Accepted-on-dev:** 2025-12-24  
**Superseded:** 2025-12-25 (Monorepo Migration)  
**Deciders:** Architecture Team  
**Tags:** repository-structure, naming-conventions, cleanup

## Context

The repository had inconsistent directory naming:
- `backend/` - Express.js server application
- `frontend/` - Next.js web application
- Root-level `package.json` and `package-lock.json` (unnecessary)

The repository serves as a monorepo holding three main applications:
1. Express server (workflows, PDF processing)
2. Next.js web application
3. React Native mobile application

### Problem Statement

Inconsistent naming caused confusion:
- `backend` vs `server` - unclear which term to use
- `frontend` vs `nextjs` - doesn't indicate framework
- Root-level package files suggested root-level dependencies (not needed)
- `.gitmodules` file existed but submodule was not present

## Decision

**Standardize directory names and remove unnecessary root-level files.**

### Changes Made

1. **Renamed directories:**
   - `backend/` → `server/` - Clearer, matches Express server terminology
   - `frontend/` → `nextjs/` - Indicates framework, matches common conventions

2. **Removed root-level files:**
   - Deleted `package.json` - No root-level dependencies needed
   - Deleted `package-lock.json` - Associated lock file
   - Deleted `node_modules/` - Root-level dependencies not needed
   - Deleted `.gitmodules` - Submodule not in use

3. **Updated all references:**
   - Updated `README.md` - All path references
   - Updated `AGENTS.md` - Workflow documentation
   - Updated `docs/ARCHITECTURE_DIAGRAM.md` - Architecture documentation
   - Updated `.github/workflows/playwright.yml` - CI/CD workflows
   - Updated `nextjs/README.md` - Installation instructions

4. **Reorganized scripts:**
   - Moved `test-edge-function-url.js` → `supabase/scripts/` - Better organization

## Consequences

### Positive

✅ **Clearer naming** - `server/` and `nextjs/` are self-documenting  
✅ **Consistent terminology** - Matches common industry conventions  
✅ **Cleaner root** - No unnecessary package files  
✅ **Better organization** - Scripts in appropriate directories  
✅ **Easier onboarding** - New developers understand structure immediately

### Negative

❌ **Breaking change** - Requires updating all documentation and references  
❌ **Git history** - Directory renames lose some git history context  
❌ **CI/CD updates** - Workflows needed path updates

### Neutral

- No functional changes - purely organizational
- All three applications remain independent
- Monorepo structure preserved

## Implementation Details

### New Structure

```
knowledgeMgmtSystemOct2025/
├── server/          # Express.js server (was backend/)
├── nextjs/          # Next.js web app (was frontend/)
├── mobile/          # React Native app
├── supabase/        # Supabase config, migrations, functions
├── docs/            # Documentation
├── data/            # Sample data
├── n8n/             # n8n workflows
└── README.md        # Main documentation
```

### Updated References

All documentation and code references updated to use:
- `server/` instead of `backend/`
- `nextjs/` instead of `frontend/`

## Alternatives Considered

### Alternative 1: Keep Original Names
- **Pros:** No changes needed
- **Cons:** Confusing terminology, inconsistent with conventions

### Alternative 2: Use `api/` instead of `server/`
- **Pros:** Common convention
- **Cons:** Less accurate (server does more than API)

### Alternative 3: Use `web/` instead of `nextjs/`
- **Pros:** Framework-agnostic
- **Cons:** Less specific, doesn't indicate Next.js

## Notes

- This is a purely organizational change with no functional impact
- All three applications remain independent with their own `package.json` files
- Repository structure is now clearer and more maintainable
- Follows common monorepo patterns

## Superseded By

**Note:** This ADR was superseded in December 2025 by the Monorepo Migration, which moved all packages into `packages/` directory:
- `server/` → `packages/worker/`
- `nextjs/` → `packages/web/`
- `mobile/` → `packages/mobile/`
- Added `packages/shared/` for shared types and utilities

See README.md "Monorepo Migration (December 2025)" section for current structure.

## References

- Main README: `README.md`
- Architecture: `docs/ARCHITECTURE_DIAGRAM.md`
- Workflow Docs: `AGENTS.md`

