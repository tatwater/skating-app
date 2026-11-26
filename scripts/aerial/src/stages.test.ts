import { describe, expect, test } from 'vitest';
import { archiveKey } from './keys';
import {
  AERIAL_STAGES,
  AERIAL_USAGE,
  ALL_STAGES,
  parseCellList,
  parseStageArgs,
  StageArgsError,
  stageArgsToOptions,
  stagesToRun,
} from './stages';

const BUILD = 'naip-20261212';
const PILOT = 'naip-pilot-20261201';
const OLD = archiveKey('naip-20260705');

const parse = (line: string, forStage?: Parameters<typeof parseStageArgs>[1]) =>
  parseStageArgs(line.split(' ').filter(Boolean), forStage);

const refused = (line: string, message: RegExp, forStage?: Parameters<typeof parseStageArgs>[1]) =>
  expect(() => parse(line, forStage)).toThrow(message);

describe('parseStageArgs: what it reads', () => {
  test('a bare campaign runs everything, narrowed by nothing', () => {
    expect(parse(BUILD)).toEqual({
      campaign: BUILD,
      stage: 'all',
      states: null,
      cells: null,
      fromCurrent: false,
      pilot: null,
      dryRun: false,
      old: null,
    });
  });

  test('every flag, in both spellings', () => {
    const spaced = parse(`${BUILD} --stage tiles --states vt,NH,vt --from-current --dry-run`);
    const joined = parse(`${BUILD} --stage=tiles --states=vt,NH,vt --from-current --dry-run`);
    expect(spaced).toEqual(joined);
    expect(spaced).toMatchObject({
      stage: 'tiles',
      states: ['NH', 'VT'],
      fromCurrent: true,
      dryRun: true,
    });
  });

  test('--cells takes a path', () => {
    expect(parse(`${BUILD} --stage select --cells pilot.txt`).cells).toBe('pilot.txt');
  });

  test('a pilot names itself, on a pilot campaign', () => {
    expect(parse(`${PILOT} --pilot champlain-nhma`).pilot).toBe('champlain-nhma');
  });

  test('cleanup takes --old, a published archive key', () => {
    expect(parse(`${BUILD} --stage cleanup --old ${OLD} --dry-run`)).toMatchObject({
      stage: 'cleanup',
      old: OLD,
      dryRun: true,
    });
  });

  test('a stage CLI runs its own stage, with or without --stage naming it', () => {
    expect(parse(BUILD, 'select').stage).toBe('select');
    expect(parse(`${BUILD} --stage select`, 'select').stage).toBe('select');
    expect(parse(`${BUILD} --old ${OLD}`, 'cleanup').old).toBe(OLD);
  });

  test('every stage name is accepted', () => {
    for (const stage of AERIAL_STAGES) {
      const line =
        stage === 'cleanup'
          ? `${BUILD} --stage ${stage} --old ${OLD}`
          : `${BUILD} --stage ${stage}`;
      expect(parse(line).stage).toBe(stage);
    }
  });
});

describe('parseStageArgs: what it refuses, before any work', () => {
  test.each([
    ['', /the campaign comes first/],
    ['--stage select', /the campaign comes first/],
    ['naip-2026', /is not naip-<YYYYMMDD>/],
    ['naip-20260231', /not a day/],
    [`${BUILD} extra`, /unexpected argument "extra"/],
    [`${BUILD} --verbose`, /unknown flag --verbose/],
    [`${BUILD} --stage`, /--stage needs a value/],
    [`${BUILD} --stage --dry-run`, /--stage needs a value/],
    [`${BUILD} --stage=`, /--stage needs a value/],
    [`${BUILD} --stage publish`, /unknown stage "publish"/],
    [`${BUILD} --stage tiles --stage select`, /--stage given twice/],
    [`${BUILD} --dry-run --dry-run`, /--dry-run given twice/],
    [`${BUILD} --dry-run=yes`, /--dry-run takes no value/],
    [`${BUILD} --states NH,NJ`, /"NJ" is not one of the seven/],
    [`${BUILD} --states NH,`, /"" is not one of the seven/],
    [`${BUILD} --states NH --cells c.txt`, /give one/],
    [`${BUILD} --pilot champlain`, /--pilot needs a pilot campaign/],
    [PILOT, /is a pilot campaign: give --pilot/],
    [`${PILOT} --pilot Champlain`, /lowercase words/],
    [`${BUILD} --stage cleanup`, /cleanup needs --old/],
    [`${BUILD} --stage cleanup --old dev/naip/other.pmtiles`, /--old: .* is not a summer aerial/],
    [`${BUILD} --stage cleanup --old ${OLD} --states NH`, /cleanup takes --old/],
    [`${BUILD} --stage cleanup --old ${OLD} --from-current`, /cleanup takes --old/],
    [`${BUILD} --old ${OLD}`, /--old belongs to --stage cleanup/],
    [`${BUILD} --stage verify --old ${OLD}`, /--old belongs to --stage cleanup/],
  ])('%j', (line, message) => {
    refused(line, message);
  });

  test('a stage CLI refuses another stage', () => {
    refused(`${BUILD} --stage tiles`, /this is the select stage/, 'select');
    refused(`${BUILD} --stage all`, /this is the assemble stage/, 'assemble');
  });

  test('every refusal is a StageArgsError, and the usage names every flag', () => {
    expect(() => parse(`${BUILD} --nope`)).toThrow(StageArgsError);
    for (const flag of [
      '--stage',
      '--states',
      '--cells',
      '--from-current',
      '--pilot',
      '--dry-run',
      '--old',
    ]) {
      expect(AERIAL_USAGE).toContain(flag);
    }
  });
});

describe('stagesToRun', () => {
  test('all is select → tiles → assemble → verify; cleanup is never in it', () => {
    expect(stagesToRun('all')).toEqual(['select', 'tiles', 'assemble', 'verify']);
    expect(ALL_STAGES).not.toContain('cleanup');
    expect(stagesToRun('cleanup')).toEqual(['cleanup']);
  });
});

describe('stageArgsToOptions', () => {
  test('carries every given flag and leaves the absent ones out', () => {
    expect(stageArgsToOptions(parse(BUILD))).toEqual({ stage: 'all' });
    expect(
      stageArgsToOptions(
        parse(`${PILOT} --pilot p --stage tiles --states ME --from-current --dry-run`),
      ),
    ).toEqual({ stage: 'tiles', states: ['ME'], fromCurrent: true, pilot: 'p', dryRun: true });
    expect(stageArgsToOptions(parse(`${BUILD} --cells c.txt`))).toEqual({
      stage: 'all',
      cells: 'c.txt',
    });
    expect(stageArgsToOptions(parse(`${BUILD} --stage cleanup --old ${OLD}`))).toEqual({
      stage: 'cleanup',
      old: OLD,
    });
  });
});

describe('parseCellList', () => {
  test('one key a line, comments and blanks skipped, sorted and deduplicated', () => {
    expect(parseCellList('# the pilot\n4407339ne\n\n4407336nw  # Champlain\n4407339ne\n')).toEqual([
      '4407336nw',
      '4407339ne',
    ]);
  });

  test('names the line that is not a key', () => {
    expect(() => parseCellList('4407339ne\n4407339\n')).toThrow(/line 2: "4407339"/);
    expect(() => parseCellList('4407339NE')).toThrow(StageArgsError);
  });

  test('refuses a list with no cell', () => {
    expect(() => parseCellList('# nothing\n\n')).toThrow(/lists no cell/);
  });
});
