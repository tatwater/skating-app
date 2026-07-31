import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ConsensusMember, type ConsensusVote, clusterConsensus } from './hazardConsensus';
import { HAZARD_VERDICTS } from './hazardLifecycle';

function member(
  id: string,
  createdByUserId: string,
  confirmCount = 0,
  lastConfirmedAt = 1_000,
): ConsensusMember {
  return { id, createdByUserId, confirmCount, lastConfirmedAt };
}

function vote(
  hazardId: string,
  userId: string,
  verdict: ConsensusVote['verdict'] = 'still_there',
  at = 2_000,
): ConsensusVote {
  return { hazardId, userId, verdict, at };
}

describe('clusterConsensus', () => {
  it('leaves a singleton exactly as its row already reads', () => {
    const consensus = clusterConsensus([member('a', 'alex', 3, 5_000)], []);
    expect(consensus.get('a')).toEqual({
      confirmCount: 3,
      lastConfirmedAt: 5_000,
      memberIds: ['a'],
    });
  });

  it('counts a second reporter as a witness, with no confirm taps anywhere', () => {
    // The case the whole mechanism exists for: two people mark the same ridge, neither taps confirm.
    // Before pooling both pins sit at zero and every phone on the lake gets the soft prompt.
    const consensus = clusterConsensus([member('a', 'alex'), member('b', 'sam')], []);
    expect(consensus.get('a')?.confirmCount).toBe(1);
    expect(consensus.get('b')?.confirmCount).toBe(1);
  });

  it('never lets one person corroborate themselves across their own duplicates', () => {
    // Alex posts the same ridge twice from the web. That is one witness, not two — D54's confirm-gate
    // says you cannot vouch for your own report, and posting it again is still vouching.
    const consensus = clusterConsensus([member('a', 'alex'), member('b', 'alex')], []);
    expect(consensus.get('a')?.confirmCount).toBe(0);
    expect(consensus.get('b')?.confirmCount).toBe(0);
  });

  it('pools confirmations cast on different members', () => {
    // Three people confirm a real ridge across three duplicates. Per row each pin has one confirm; the
    // community has said it three times, and the alert escalation should hear that.
    const consensus = clusterConsensus(
      [member('a', 'alex'), member('b', 'alex'), member('c', 'alex')],
      [vote('a', 'sam'), vote('b', 'kim'), vote('c', 'lee')],
    );
    expect(consensus.get('a')?.confirmCount).toBe(3);
  });

  it('counts one person confirming two duplicates once', () => {
    const consensus = clusterConsensus(
      [member('a', 'alex'), member('b', 'alex')],
      [vote('a', 'sam'), vote('b', 'sam')],
    );
    expect(consensus.get('a')?.confirmCount).toBe(1);
  });

  it("takes each user's latest verdict per hazard, as the row derivation does", () => {
    // Sam confirmed, then came back and said it healed. Their current opinion is not a confirmation.
    const consensus = clusterConsensus(
      [member('a', 'alex'), member('b', 'kim')],
      [vote('a', 'sam', 'still_there', 1_000), vote('a', 'sam', 'fully_healed', 9_000)],
    );
    // Kim (who drew 'b') is still a witness; Sam is not.
    expect(consensus.get('a')?.confirmCount).toBe(1);
  });

  it('never pools a "gone" verdict into anything', () => {
    // Two people clearing one pin must not retire the neighbour nobody looked at. Nothing in this
    // module reads `fully_healed` / `never_existed` at all — archival stays strictly per-row.
    const withGone = clusterConsensus(
      [member('a', 'alex'), member('b', 'kim')],
      [vote('a', 'sam', 'fully_healed'), vote('a', 'lee', 'fully_healed')],
    );
    const without = clusterConsensus([member('a', 'alex'), member('b', 'kim')], []);
    expect(withGone.get('a')?.confirmCount).toBe(without.get('a')?.confirmCount);
    expect(withGone.get('b')?.confirmCount).toBe(without.get('b')?.confirmCount);
  });

  it('carries the newest clock in the cluster to every member', () => {
    const consensus = clusterConsensus(
      [member('a', 'alex', 0, 1_000), member('b', 'kim', 0, 8_000)],
      [],
    );
    // The stale pin reads as fresh as the community actually is — a duplicate drawn today is somebody
    // standing there today, whether or not they pressed confirm on the older pin.
    expect(consensus.get('a')?.lastConfirmedAt).toBe(8_000);
    expect(consensus.get('b')?.lastConfirmedAt).toBe(8_000);
  });

  it('lets a vote push the clock past every stored value', () => {
    const consensus = clusterConsensus(
      [member('a', 'alex', 0, 1_000), member('b', 'kim', 0, 2_000)],
      [vote('a', 'sam', 'still_there', 9_000)],
    );
    expect(consensus.get('a')?.lastConfirmedAt).toBe(9_000);
  });

  it('is monotone — pooling never reports fewer witnesses than the row already had (property)', () => {
    // The safety-relevant direction. Pooling may only ever make a hazard louder: a cluster that
    // reported *less* corroboration than one of its rows would quietly de-escalate a live warning.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 4 }),
            author: fc.constantFrom('alex', 'sam', 'kim', 'lee'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.array(
          fc.record({
            hazardId: fc.string({ minLength: 1, maxLength: 4 }),
            userId: fc.constantFrom('alex', 'sam', 'kim', 'lee', 'jo'),
            verdict: fc.constantFrom(...HAZARD_VERDICTS),
            at: fc.integer({ min: 1, max: 10_000 }),
          }),
          { maxLength: 12 },
        ),
        (rawMembers, votes) => {
          const seen = new Set<string>();
          const members: ConsensusMember[] = [];
          for (const m of rawMembers) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            // The row's own stored count, derived the way the server derives it: distinct non-author
            // users on THIS hazard whose current verdict is `still_there`.
            const latest = new Map<string, (typeof votes)[number]>();
            for (const v of votes) {
              if (v.hazardId !== m.id) continue;
              const prior = latest.get(v.userId);
              if (!prior || v.at >= prior.at) latest.set(v.userId, v);
            }
            let own = 0;
            for (const v of latest.values()) {
              if (v.userId !== m.author && v.verdict === 'still_there') own += 1;
            }
            members.push(member(m.id, m.author, own, 1_000));
          }
          const consensus = clusterConsensus(members, votes);
          for (const m of members) {
            expect(consensus.get(m.id)?.confirmCount).toBeGreaterThanOrEqual(m.confirmCount);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('gives every member an entry', () => {
    const members = [member('a', 'alex'), member('b', 'kim'), member('c', 'sam')];
    const consensus = clusterConsensus(members, []);
    expect([...consensus.keys()].sort()).toEqual(['a', 'b', 'c']);
  });
});
