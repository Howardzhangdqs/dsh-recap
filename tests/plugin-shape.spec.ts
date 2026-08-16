/**
 * Plugin-shape consistency: the manifest, the bundle patch, and the package
 * declaration must agree on identity and entry points (the two install
 * channels' browser-side `arrive()` checks require bundle id === plugin id).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('plugin shape', () => {
  it('manifest id, package name, and patch row agree', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string }
    const manifest = JSON.parse(await readFile(join(root, 'dsh.plugin.json'), 'utf8')) as { id: string; version: string; main: string; client: { main: string } }
    expect(pkg.name).toBe('dsh-recap')
    expect(manifest.id).toBe(`dsh-external/${pkg.name}`)
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.client.main).toBe('./lib/client-registry.js')
  })

  it('the bundle patch inserts one row named after the package', async () => {
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: 'dsh-recap'")
    expect(patch).toContain('- id: recap')
  })

  it('exports the cordis plugin surface from the host entry', async () => {
    const mod = await import(join(root, 'src/index.ts'))
    expect(mod.name).toBe('dsh-recap')
    expect(mod.inject).toEqual(['llm', 'sessions', 'webServer'])
    expect(typeof mod.apply).toBe('function')
    expect(typeof mod.Config).toBe('function') // schemastery schemas are functions
  })

  it('the invariant companion reserves package ownership', async () => {
    const mod = await import(join(root, 'src/invariant.ts'))
    expect(mod.name).toBe('dsh-recap-invariant')
    expect(mod.inject).toEqual(['invariants'])
    expect(typeof mod.apply).toBe('function')
  })
})
