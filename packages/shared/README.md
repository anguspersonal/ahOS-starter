# @ahkms/shared

Shared TypeScript types and utilities for the Knowledge Management System.

## Purpose

This package provides a single source of truth for domain types used across all packages in the monorepo. It ensures type consistency and eliminates duplication.

## Installation

This package is part of the monorepo and is automatically available to other packages. No manual installation needed.

## Usage

### Importing Types

```typescript
// Import specific types
import type { Artifact, SystemDecision, UserTask } from '@ahkms/shared';

// Import enums
import type { LifecycleStage, DecisionType, UserMode } from '@ahkms/shared';

// Import entity types
import type { ProjectEntity, AreaEntity, BaseEntity } from '@ahkms/shared';
```

### Available Types

#### Core Domain Types

**Artifacts & Workflows:**
- `Artifact` - Core artifact/upload type
- `DerivedArtifact` - Derived artifacts (thumbnails, OCR text, etc.)
- `WorkflowRun` - Workflow execution record

**System Decisions:**
- `SystemDecision` - System notifications and decisions
- `DecisionType`, `ProcessingStage`, `DecisionStatus`, `ReviewType` - Enums

**Tasks & Events:**
- `UserTask` - User tasks
- `EventItem` - Calendar events
- `TaskStatus`, `TaskPriority`, `EventType` - Enums

**User Preferences:**
- `UserPreferences` - User settings and preferences
- `DecisionFamilyThresholds` - Decision confidence thresholds
- `UserMode` - User interface mode ('casual' | 'power')

#### PARAMPS Entity Types

All PARAMPS entity types extend `BaseEntity`:

- `ProjectEntity` - Projects
- `AreaEntity` - Areas
- `ResourceEntity` - Resources
- `MemoryEntity` - Memories
- `PersonEntity` - People
- `SecureEntity` - Secure entities
- `ArchiveEntity` - Archived entities
- `BaseEntity` - Base interface for all entities

#### Search & Relations

- `GlobalSearchResults` - Global search results
- `SearchResult` - Individual search result
- `EntityWithRelations` - Entity with related data
- `ProjectWithRelations` - Project with related data

#### Enums

- `LifecycleStage` - Artifact lifecycle stages
- `ProcessingStatus` - Processing status
- `TaskStatus` - Task status
- `TaskPriority` - Task priority
- `EventType` - Event type
- `DecisionType` - Decision type
- `ProcessingStage` - Processing stage
- `DecisionStatus` - Decision status
- `ReviewType` - Review type
- `UserMode` - User interface mode
- `AutomationLevel` - Automation level

### Type Files

Types are organized in `src/types/`:

- `knowledge.ts` - Core domain types (Artifact, SystemDecision, UserTask, etc.)
- `entities.ts` - PARAMPS entity types
- `index.ts` - Re-exports all types

## When to Add Types to Shared

Add types to this package when they are:

1. **Domain Models** - Core business entities used across packages
2. **Shared Enums** - Enumerations used in multiple packages
3. **Cross-Package Types** - Types representing data shared between packages
4. **API Contracts** - Types used by multiple API clients

**Do NOT add:**
- Workflow execution types (keep in worker package)
- UI-specific types (keep in web/mobile packages)
- Platform-specific types (keep in respective packages)
- Implementation details (keep local)

See [docs/TYPE_ORGANIZATION_GUIDE.md](../../docs/guides/TYPE_ORGANIZATION_GUIDE.md) for detailed guidelines.

## Development

### Building

```bash
npm run build
```

### Watch Mode

```bash
npm run dev
```

### Type Checking

TypeScript will automatically check types when building. All packages that import from `@ahkms/shared` will get type checking.

## Related Documentation

- [TYPE_ORGANIZATION_GUIDE.md](../../docs/guides/TYPE_ORGANIZATION_GUIDE.md) - Complete guide on type organization
- [ADR008: Type Organization Standardization](../../docs/ADRs/ADR008_Type_Organization_Standardization.md) - Architecture decision record

## Contributing

When adding new types:

1. **Check if it should be shared** - See guidelines above
2. **Add to appropriate file** - `knowledge.ts` for domain types, `entities.ts` for entity types
3. **Export from index.ts** - Add to `src/types/index.ts` exports
4. **Update this README** - Add to "Available Types" section
5. **Test imports** - Verify other packages can import the new type

## Versioning

This package uses semantic versioning. Breaking changes to types should be reflected in the version number.

