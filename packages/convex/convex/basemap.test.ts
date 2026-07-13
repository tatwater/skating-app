import { convexTest } from 'convex-test'
import { expect, test } from 'vitest'
import { internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.*s')

test('generateUploadUrl mints an upload URL', async () => {
  const t = convexTest(schema, modules)
  const url = await t.mutation(internal.basemap.generateUploadUrl, {})
  expect(typeof url).toBe('string')
  expect(url.length).toBeGreaterThan(0)
})

test('getServingUrl resolves the serving URL of a stored file', async () => {
  const t = convexTest(schema, modules)
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['pmtiles'])))
  const url = await t.mutation(internal.basemap.getServingUrl, { storageId })
  expect(typeof url).toBe('string')
})
