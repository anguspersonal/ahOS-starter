#!/usr/bin/env node

/**
 * Type Duplicate Checker
 * 
 * Scans for duplicate type definitions between shared and local packages.
 * Warns if types exist in both shared and local packages.
 * 
 * Usage: node scripts/check-type-duplicates.js
 */

const fs = require('fs');
const path = require('path');

const SHARED_TYPES_DIR = path.join(__dirname, '../packages/shared/src/types');
const PACKAGES_DIR = path.join(__dirname, '../packages');

// Common domain type names that should be in shared
const DOMAIN_TYPE_NAMES = [
  'Artifact',
  'DerivedArtifact',
  'WorkflowRun',
  'SystemDecision',
  'UserTask',
  'EventItem',
  'UserPreferences',
  'DecisionFamilyThresholds',
  'ProjectEntity',
  'AreaEntity',
  'ResourceEntity',
  'MemoryEntity',
  'PersonEntity',
  'SecureEntity',
  'ArchiveEntity',
  'BaseEntity',
  'GlobalSearchResults',
  'SearchResult',
  'EntityWithRelations',
  'ProjectWithRelations',
  'UserMode',
  'LifecycleStage',
  'ProcessingStatus',
  'TaskStatus',
  'TaskPriority',
  'EventType',
  'DecisionType',
  'ProcessingStage',
  'DecisionStatus',
  'ReviewType',
  'AutomationLevel',
];

/**
 * Extract exported type/interface names from a TypeScript file
 */
function extractExportedTypes(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const types = new Set();

  // Match: export interface TypeName
  const interfaceRegex = /export\s+interface\s+(\w+)/g;
  let match;
  while ((match = interfaceRegex.exec(content)) !== null) {
    types.add(match[1]);
  }

  // Match: export type TypeName
  const typeRegex = /export\s+type\s+(\w+)/g;
  while ((match = typeRegex.exec(content)) !== null) {
    types.add(match[1]);
  }

  return Array.from(types);
}

/**
 * Get all TypeScript files in a directory recursively
 */
function getTypeScriptFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) {
    return fileList;
  }

  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Skip node_modules and dist directories
      if (file !== 'node_modules' && file !== 'dist' && file !== '__tests__') {
        getTypeScriptFiles(filePath, fileList);
      }
    } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      fileList.push(filePath);
    }
  });

  return fileList;
}

/**
 * Get all exported types from shared package
 */
function getSharedTypes() {
  const sharedFiles = getTypeScriptFiles(SHARED_TYPES_DIR);
  const sharedTypes = new Set();

  sharedFiles.forEach((file) => {
    const types = extractExportedTypes(file);
    types.forEach((type) => sharedTypes.add(type));
  });

  return sharedTypes;
}

/**
 * Get all exported types from a package (excluding shared)
 */
function getPackageTypes(packageName) {
  const packageDir = path.join(PACKAGES_DIR, packageName);
  if (!fs.existsSync(packageDir) || packageName === 'shared') {
    return new Map();
  }

  // Look in types/ directory and src/**/types.ts files
  const typeFiles = [];
  
  // Check for types/ directory
  const typesDir = path.join(packageDir, 'types');
  if (fs.existsSync(typesDir)) {
    typeFiles.push(...getTypeScriptFiles(typesDir));
  }

  // Check for src/**/types.ts files
  const srcDir = path.join(packageDir, 'src');
  if (fs.existsSync(srcDir)) {
    const allFiles = getTypeScriptFiles(srcDir);
    allFiles.forEach((file) => {
      if (file.includes('types.ts') || file.includes('types/')) {
        typeFiles.push(file);
      }
    });
  }

  const packageTypes = new Map();
  typeFiles.forEach((file) => {
    const types = extractExportedTypes(file);
    const relativePath = path.relative(packageDir, file);
    types.forEach((type) => {
      if (!packageTypes.has(type)) {
        packageTypes.set(type, []);
      }
      packageTypes.get(type).push(relativePath);
    });
  });

  return packageTypes;
}

/**
 * Main function
 */
function main() {
  console.log('🔍 Checking for duplicate type definitions...\n');

  const sharedTypes = getSharedTypes();
  const packages = ['worker', 'mobile'];
  let hasDuplicates = false;
  let duplicateCount = 0;

  packages.forEach((packageName) => {
    const packageTypes = getPackageTypes(packageName);
    
    if (packageTypes.size === 0) {
      return;
    }

    const duplicates = [];
    packageTypes.forEach((files, typeName) => {
      // Check if it's a domain type that should be in shared
      if (sharedTypes.has(typeName) || DOMAIN_TYPE_NAMES.includes(typeName)) {
        duplicates.push({ typeName, files });
      }
    });

    if (duplicates.length > 0) {
      hasDuplicates = true;
      duplicateCount += duplicates.length;
      console.log(`⚠️  ${packageName.toUpperCase()} package has ${duplicates.length} potential duplicate(s):`);
      duplicates.forEach(({ typeName, files }) => {
        const inShared = sharedTypes.has(typeName) ? ' (exists in shared)' : ' (should be in shared)';
        console.log(`   - ${typeName}${inShared}`);
        files.forEach((file) => {
          console.log(`     → ${file}`);
        });
      });
      console.log('');
    }
  });

  if (!hasDuplicates) {
    console.log('✅ No duplicate type definitions found!\n');
    process.exit(0);
  } else {
    console.log(`\n❌ Found ${duplicateCount} potential duplicate type definition(s).`);
    console.log('   Consider migrating these types to @ahkms/shared or removing duplicates.');
    console.log('   See docs/TYPE_ORGANIZATION_GUIDE.md for guidelines.\n');
    process.exit(1);
  }
}

main();

