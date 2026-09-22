import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  findProjectRoot,
  installSkill,
  installFromUpload,
  listInstallCandidates,
  rewriteInvocation,
  scanSkills,
  toggleSkill,
} from '../lib/skills.js'

const BODY = '# Keep me\n\nSecond line.\n'

/**
 * @param {string} root
 * @param {string} name
 * @param {string} [extra]
 */
async function writeSkill(root, name, extra = '') {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does work.\n${extra}---\n${BODY}`)
  return dir
}

test('findProjectRoot stops at the nearest .git ancestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-git-'))
  try {
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'nested', 'deeper'), { recursive: true })
    assert.equal(await findProjectRoot(join(root, 'nested', 'deeper')), root)
    const loose = await mkdtemp(join(tmpdir(), 'dsh-skill-nogit-'))
    try {
      assert.equal(await findProjectRoot(loose), loose)
    } finally {
      await rm(loose, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scan keeps the lowest rank and records the covered copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-scan-'))
  try {
    const project = join(root, 'project')
    const global = join(root, 'global')
    const nested = join(project, 'ok-skill', 'nested')
    await writeSkill(project, 'ok-skill')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'SKILL.md'), '---\nname: hidden-skill\ndescription: no\n---\nno\n')
    await writeFile(join(project, 'BadName', 'SKILL.md'), '---\nname: bad-name\ndescription: no\n---\nno\n').catch(() => {})
    await mkdir(join(project, 'BadName'), { recursive: true })
    await writeFile(join(project, 'BadName', 'SKILL.md'), '---\nname: bad-name\ndescription: no\n---\nno\n')
    await writeSkill(global, 'ok-skill', 'user-invocable: false\n')
    await writeFile(join(global, 'flat-skill.md'), '---\nname: flat-skill\ndescription: flat one\n---\nflat\n')
    const skills = await scanSkills([
      { path: project, rank: 100, scope: 'project' },
      { path: global, rank: 400, scope: 'global' },
    ])
    const winner = skills.find((item) => item.name === 'ok-skill')
    assert.ok(winner)
    assert.equal(winner.rank, 100)
    assert.equal(winner.scope, 'project')
    assert.equal(winner.enabled, true)
    assert.equal(winner.shadowedBy, join(global, 'ok-skill'))
    assert.equal(skills.some((item) => item.name === 'hidden-skill'), false)
    assert.equal(skills.some((item) => item.name === 'bad-name'), false)
    const flat = skills.find((item) => item.name === 'flat-skill')
    assert.equal(flat?.sourceDir, join(global, 'flat-skill.md'))
    const covered = skills.find((item) => item.name === 'ok-skill' && item.rank === 400)
    assert.equal(covered, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('folded description and nested frontmatter still count as a skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-fold-'))
  try {
    const dir = join(root, 'medical-decision-support-system')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), [
      '---',
      'name: medical-decision-support-system',
      'description: >-',
      '  执行医院运营与质量指标的数据驱动辅助决策。',
      '  不用于临床诊断。',
      'config:',
      '  sql_dialect: mysql',
      '---',
      '# body',
      '',
    ].join('\n'))
    const skills = await scanSkills([{ path: root, rank: 400, scope: 'global' }])
    assert.equal(skills.length, 1)
    assert.equal(skills[0]?.name, 'medical-decision-support-system')
    assert.match(skills[0]?.description ?? '', /执行医院运营/)
    assert.equal(skills[0]?.enabled, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rewriteInvocation only changes the two switches', () => {
  const raw = `---\nname: ok-skill\ndescription: keep\n---\n${BODY}`
  const off = rewriteInvocation(raw, false)
  assert.ok(off)
  assert.match(off, /disable-model-invocation: true\n/)
  assert.match(off, /user-invocable: false\n/)
  assert.ok(off.endsWith(BODY))
  assert.match(off, /description: keep\n/)
  const on = rewriteInvocation(off, true)
  assert.equal(on, raw)
})

test('toggle writes SKILL.md and refuses a read-only layer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-toggle-'))
  const project = join(root, 'repo')
  try {
    await mkdir(join(project, '.git'), { recursive: true })
    const source = await writeSkill(join(project, '.dsh', 'skills'), 'ok-skill')
    await toggleSkill(source, false, project)
    const off = await readFile(join(source, 'SKILL.md'), 'utf8')
    assert.match(off, /disable-model-invocation: true/)
    assert.match(off, /user-invocable: false/)
    assert.ok(off.endsWith(BODY))
    await toggleSkill(source, true, project)
    assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), `---\nname: ok-skill\ndescription: ok-skill does work.\n---\n${BODY}`)
    const agents = await writeSkill(join(project, '.agents', 'skills'), 'other-skill')
    await assert.rejects(() => toggleSkill(agents, false, project), /只读/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('install copies into the project root and rejects a second copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-install-'))
  const project = join(root, 'repo')
  const sourceParent = join(root, 'src')
  try {
    await mkdir(join(project, '.git'), { recursive: true })
    const source = await writeSkill(sourceParent, 'ok-skill')
    await writeFile(join(source, 'notes.txt'), 'extra\n')
    const installed = await installSkill(source, 'project', project)
    assert.equal(installed.sourceDir, join(project, '.dsh', 'skills', 'ok-skill'))
    assert.equal(await readFile(join(installed.sourceDir, 'notes.txt'), 'utf8'), 'extra\n')
    await assert.rejects(() => installSkill(source, 'project', project), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.message, 'already-installed')
      return true
    })
    const candidates = await listInstallCandidates(join(root, 'missing-repo'))
    assert.deepEqual(candidates, [])
    await mkdir(join(project, 'skills'), { recursive: true })
    await writeSkill(join(project, 'skills'), 'candidate-skill')
    const listed = await listInstallCandidates(project)
    assert.equal(listed[0]?.name, 'candidate-skill')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('upload installs a folder, a zip, and a tarball', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-upload-'))
  const project = join(root, 'repo')
  const sourceParent = join(root, 'src')
  try {
    await mkdir(join(project, '.git'), { recursive: true })
    const source = await writeSkill(sourceParent, 'ok-skill')
    await writeFile(join(source, 'notes.txt'), 'extra\n')
    const installed = await installFromUpload([
      { name: 'ok-skill/SKILL.md', bytes: await readFile(join(source, 'SKILL.md')) },
      { name: 'ok-skill/notes.txt', bytes: await readFile(join(source, 'notes.txt')) },
    ], 'project', project)
    assert.equal(installed.sourceDir, join(project, '.dsh', 'skills', 'ok-skill'))
    assert.equal(await readFile(join(installed.sourceDir, 'notes.txt'), 'utf8'), 'extra\n')

    await rm(installed.sourceDir, { recursive: true, force: true })
    execFileSync('zip', ['-qr', join(root, 'ok-skill.zip'), 'ok-skill'], { cwd: sourceParent })
    const fromZip = await installFromUpload([
      { name: 'ok-skill.zip', bytes: await readFile(join(root, 'ok-skill.zip')) },
    ], 'project', project)
    assert.equal(await readFile(join(fromZip.sourceDir, 'notes.txt'), 'utf8'), 'extra\n')

    await rm(fromZip.sourceDir, { recursive: true, force: true })
    execFileSync('tar', ['-czf', join(root, 'ok-skill.tgz'), 'ok-skill'], { cwd: sourceParent })
    const fromTar = await installFromUpload([
      { name: 'ok-skill.tgz', bytes: await readFile(join(root, 'ok-skill.tgz')) },
    ], 'project', project)
    assert.equal(await readFile(join(fromTar.sourceDir, 'notes.txt'), 'utf8'), 'extra\n')

    await assert.rejects(
      () => installFromUpload([{ name: 'empty.txt', bytes: Buffer.from('nope') }], 'project', project),
      (error) => error instanceof Error && error.message === '找不到 SKILL.md',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
