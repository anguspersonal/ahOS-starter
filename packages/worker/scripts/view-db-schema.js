// Script to view current database schema
// Usage: node scripts/view-db-schema.js
// Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables

const { supabase } = require('../src/db/client');

async function viewDatabaseSchema() {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('DATABASE SCHEMA OVERVIEW');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // List of known tables to check
    const tablesToCheck = [
      'artifacts',
      'entities',
      'entity_relationships',
      'user_tasks',
      'events',
      'system_decisions',
      'user_preferences',
      'workflows',
      'workflow_runs',
      'notifications',
      'waitlist_entries',
      'teams',
      'derived_artifacts',
      'activity_logs'
    ];

    console.log('Checking tables and row counts:\n');

    for (const tableName of tablesToCheck) {
      try {
        const { data, error, count } = await supabase
          .from(tableName)
          .select('*', { count: 'exact', head: true });

        if (!error) {
          console.log(`✓ ${tableName.padEnd(25)} ${(count || 0).toString().padStart(6)} rows`);
        } else {
          // Check if it's a permission error or table doesn't exist
          if (error.code === 'PGRST116' || error.message.includes('does not exist')) {
            console.log(`✗ ${tableName.padEnd(25)} (table does not exist)`);
          } else {
            console.log(`? ${tableName.padEnd(25)} (error: ${error.message})`);
          }
        }
      } catch (err) {
        console.log(`✗ ${tableName.padEnd(25)} (error: ${err.message})`);
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('To get detailed schema:');
    console.log('  1. Use Supabase Dashboard → Database → Tables');
    console.log('  2. Or run: npx supabase db dump --schema public --linked');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (err) {
    console.error('Error viewing database schema:', err.message);
    console.log('\nMake sure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in your environment.');
  }
}

// Run if called directly
if (require.main === module) {
  viewDatabaseSchema().catch(console.error);
}

module.exports = { viewDatabaseSchema };
