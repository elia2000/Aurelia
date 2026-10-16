import { detectRunningServer } from './_db-admin.js'

const { running, port } = await detectRunningServer()
if (running) {
  console.error(
    `Refusing to run db:migrate while Aurelle is running on port ${port}. Stop the server first so sql.js cannot race the migration writer.`,
  )
  process.exit(1)
}

const { getCurrentSchemaVersion } = await import('../db.js')

console.log(`Migrations complete. Current schema version: ${getCurrentSchemaVersion()}`)
