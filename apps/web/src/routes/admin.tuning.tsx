import {
  AUTO_LOW_QUALITY_NET_UNHELPFUL,
  BOUNTY_ELIGIBILITY_WINDOW_HOURS,
  BOUNTY_REOPEN_FREEZING_DEGREE_HOURS,
  BOUNTY_REOPEN_THAW_DEGREE_HOURS,
  CONTRADICTION_FLAG_THRESHOLD,
  CORROBORATION_MAX_PER_REPORT,
  DEFAULT_BOUNTY_LIFETIME_MS,
  DEFAULT_BOUNTY_REWARD_POINTS,
  DISPLAY_AREA_MAX_SQM,
  DISPLAY_AREA_MIN_SQM,
  FRESH_REPORT_HOURS,
  HAZARD_CORROBORATION_MIN_CONFIRMS,
  MAX_OPEN_BOUNTIES_PER_DAY,
  MIN_VISIBLE_ZOOM_FLOOR,
  MIN_VISIBLE_ZOOM_WIDEST,
  NET_THUMBS_MAX,
  NET_THUMBS_MIN,
  NEW_ACCOUNT_WINDOW_MS,
  PATH_MIN_OPACITY,
  POINT_WEIGHTS,
  REPORT_FRESHNESS_HALF_LIFE_HOURS,
  REPORT_FRESHNESS_MAX_EXTENSION,
  REPORT_FRESHNESS_PER_CORROBORATION,
  REPORT_FRESHNESS_PER_THUMB,
  REPORT_FRESHNESS_WEATHER_MULTIPLIER,
  TRUST_CLASS_THRESHOLDS,
} from '@skating/core';
import { createFileRoute } from '@tanstack/react-router';
import { AdminPageHeader } from '../components/admin/adminUi';
import { ConstantCard, TuningSection } from '../components/admin/ConstantCard';
import {
  GateScatterCard,
  MetricComposition,
  MetricHistogram,
  ScalarTrend,
  useCatalogue,
} from '../components/admin/MetricCharts';

/**
 * Tuning control-room (D37/D49, Phase 7b) — **admin-only**. Every tunable constant, rendered read-only
 * beside the chart that tells you whether it's set right (settled decision #1: the founder tunes by
 * editing the constant and redeploying, so the dashboard's job is to make the effect legible, not to
 * offer an edit field). Constants come straight from `@skating/core`, so the value shown is the value
 * running; charts come from the metric rollups.
 */
export const Route = createFileRoute('/admin/tuning')({ component: AdminTuning });

const DAY_MS = 24 * 60 * 60 * 1000;

function AdminTuning() {
  const catalogue = useCatalogue();

  return (
    <div className="flex flex-col gap-10">
      <AdminPageHeader
        title="Tuning"
        subtitle="Every constant paired with the chart that tells you whether it's set right. Read-only — edit the constant and redeploy."
      />

      {/* ── Bounties ─────────────────────────────────────────────────────── */}
      <TuningSection
        title="Bounties"
        blurb="The freshness gate and the daily cap decide who may ask for fresh eyes. The scatter shows every attempt; the rates show whether the weather-reopen thresholds ever fire."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ConstantCard
            name="FRESH_REPORT_HOURS"
            value={`${FRESH_REPORT_HOURS}h`}
            file="reputationConfig.ts"
          >
            The base window a report suppresses new bounties, stretched by the author's trust and
            the report's thumbs. Mostly-suppressed attempts mean this is too long.
          </ConstantCard>
          <ConstantCard
            name="BOUNTY_REOPEN_FREEZING_DEGREE_HOURS"
            value={BOUNTY_REOPEN_FREEZING_DEGREE_HOURS}
            file="reputationConfig.ts"
          >
            How hard a freeze since a report counts as "the ice changed → reopen the bounty now".
            Raise it and a corroborated report holds bounties off through more cold.
          </ConstantCard>
          <ConstantCard
            name="BOUNTY_REOPEN_THAW_DEGREE_HOURS"
            value={BOUNTY_REOPEN_THAW_DEGREE_HOURS}
            file="reputationConfig.ts"
          >
            The thaw counterpart. A flat-zero reopen rate through a real thaw means these two are
            set too high to ever fire.
          </ConstantCard>
          <ConstantCard
            name="MAX_OPEN_BOUNTIES_PER_DAY"
            value={MAX_OPEN_BOUNTIES_PER_DAY}
            file="reputationConfig.ts"
          >
            The rolling per-requester cap — the only junk control. A high cap-hit rate says it's
            tight; if a few requesters drive all of it, that's the case for the per-user lever
            (D57).
          </ConstantCard>
          <ConstantCard
            name="DEFAULT_BOUNTY_LIFETIME_MS"
            value={`${Math.round(DEFAULT_BOUNTY_LIFETIME_MS / DAY_MS)}d`}
            file="reputationConfig.ts"
          >
            How long a bounty stays open before it expires. Compare against the time-to-fulfillment
            histogram — a lifetime far beyond the tail is just clutter.
          </ConstantCard>
          <ConstantCard
            name="DEFAULT_BOUNTY_REWARD_POINTS"
            value={DEFAULT_BOUNTY_REWARD_POINTS}
            file="reputationConfig.ts"
          >
            The bounty-point reward for fulfilling one. A high expired-without-fulfillment share may
            mean the reward is too low to draw an answer.
          </ConstantCard>
          <ConstantCard
            name="BOUNTY_ELIGIBILITY_WINDOW_HOURS"
            value={`${BOUNTY_ELIGIBILITY_WINDOW_HOURS}h`}
            file="reputationConfig.ts"
          >
            How far back the create fan-out looks for "skated here recently" authors to notify.
          </ConstantCard>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <GateScatterCard />
          <MetricComposition metricKey="bounty_outcomes" catalogue={catalogue} semantic />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <ScalarTrend
            title="Weather-reopen rate"
            description="Share of attempts a freeze/thaw flipped from block to allow. Flat zero through a thaw ⇒ the reopen thresholds are too high."
            metrics={[{ key: 'bounty_weather_reopen_rate', label: 'Reopen rate', status: 'good' }]}
            percent
            height={160}
          />
          <ScalarTrend
            title="Daily-cap hit rate"
            description="Share of attempts rejected by the per-requester cap."
            metrics={[{ key: 'bounty_cap_hit_rate', label: 'Cap-hit rate', status: 'warning' }]}
            percent
            height={160}
          />
        </div>
        <MetricHistogram metricKey="bounty_time_to_fulfillment_h" catalogue={catalogue} />
      </TuningSection>

      {/* ── Trust & points ───────────────────────────────────────────────── */}
      <TuningSection
        title="Trust & points"
        blurb="The class thresholds and the point weights decide who reads as trusted. The histogram overlays the cutoffs on the real distribution; the composition shows whether volume is masquerading as trust."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ConstantCard
            name="TRUST_CLASS_THRESHOLDS"
            value={`${TRUST_CLASS_THRESHOLDS.trusted} / ${TRUST_CLASS_THRESHOLDS.expert} / ${TRUST_CLASS_THRESHOLDS.leader}`}
            file="reputationConfig.ts"
          >
            The point floors for trusted / expert / leader. The histogram draws these as lines — if
            everyone bunches just under a cutoff, move it.
          </ConstantCard>
          <ConstantCard
            name="NEW_ACCOUNT_WINDOW_MS"
            value={`${Math.round(NEW_ACCOUNT_WINDOW_MS / DAY_MS)}d`}
            file="reputationConfig.ts"
          >
            How long a fresh account shows the "New" chip regardless of points — a welcome, not a
            verdict.
          </ConstantCard>
          <ConstantCard
            name="POINT_WEIGHTS.report_submitted"
            value={POINT_WEIGHTS.report_submitted}
            file="reputationConfig.ts"
          >
            The baseline award for posting. If the point-source composition is dominated by
            submissions, volume is buying trust — lower this or raise the peer-signal weights.
          </ConstantCard>
          <ConstantCard
            name="POINT_WEIGHTS.helpful_thumb"
            value={POINT_WEIGHTS.helpful_thumb}
            file="reputationConfig.ts"
          >
            A peer thumbing your report or hazard helpful — the strongest single signal, on purpose.
          </ConstantCard>
          <ConstantCard
            name="POINT_WEIGHTS.report_corroborated"
            value={POINT_WEIGHTS.report_corroborated}
            file="reputationConfig.ts"
          >
            Independent same-body agreement in the corroboration window — earned by both authors.
          </ConstantCard>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <MetricHistogram
            metricKey="reputation_points_hist"
            catalogue={catalogue}
            markers={[
              { atLabel: '15–29', label: 'trusted' },
              { atLabel: '60–99', label: 'expert' },
              { atLabel: '150–249', label: 'leader' },
            ]}
          />
          <MetricComposition metricKey="point_source_composition" catalogue={catalogue} />
        </div>
      </TuningSection>

      {/* ── Enforcement ──────────────────────────────────────────────────── */}
      <TuningSection
        title="Enforcement"
        blurb="The contradiction gate and the auto-flag thresholds route bad-faith reporting to a human. If the weather gate explains away almost everything, it's too permissive; if most auto-flags get dismissed, the threshold is too low."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ConstantCard
            name="CONTRADICTION_FLAG_THRESHOLD"
            value={CONTRADICTION_FLAG_THRESHOLD}
            file="reputationConfig.ts"
          >
            How many weather-unexplained contradictions before a contributor is flagged for review.
            The contradiction histogram shows the distribution; a long tail past this means too many
            flags.
          </ConstantCard>
          <ConstantCard
            name="AUTO_LOW_QUALITY_NET_UNHELPFUL"
            value={AUTO_LOW_QUALITY_NET_UNHELPFUL}
            file="reputationConfig.ts"
          >
            Net-unhelpful thumbs at which a target is routed to the queue. Mostly-dismissed
            auto_low_quality flags say this is too low.
          </ConstantCard>
          <ConstantCard
            name="CORROBORATION_MAX_PER_REPORT"
            value={CORROBORATION_MAX_PER_REPORT}
            file="reputationConfig.ts"
          >
            Cap on how many prior reports one submission may corroborate — bounds a burst windfall.
          </ConstantCard>
          <ConstantCard
            name="HAZARD_CORROBORATION_MIN_CONFIRMS"
            value={HAZARD_CORROBORATION_MIN_CONFIRMS}
            file="reputationConfig.ts"
          >
            Confirmations (author excluded) before a hazard corroborates its author.
          </ConstantCard>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <ScalarTrend
            title="Contradiction gate"
            description="Disagreements considered (pairs), the share weather explained away, and reports escalated. Not a strict funnel — the first counts pairs, the last counts reports — but if weather explains away almost everything, the 48/36 gate is too permissive."
            metrics={[
              { key: 'contradiction_detected', label: 'Considered (pairs)' },
              {
                key: 'contradiction_weather_explained',
                label: 'Weather-explained',
                status: 'warning',
              },
              { key: 'contradiction_escalated', label: 'Escalated (reports)', status: 'bad' },
            ]}
            height={180}
          />
          <MetricHistogram
            metricKey="contradiction_count_hist"
            catalogue={catalogue}
            markers={[{ atLabel: '3–4', label: 'flag' }]}
            color="warning"
          />
        </div>
        <MetricComposition metricKey="flag_dispositions" catalogue={catalogue} semantic />
      </TuningSection>

      {/* ── Hazards ──────────────────────────────────────────────────────── */}
      <TuningSection
        title="Hazards"
        blurb="Per-type decay durations live in hazardDecay.ts (one row per type — too many to list here). These two charts are the empirical check on that whole table: a type that keeps getting confirmed 'still here' past its stale line is decaying too fast."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <MetricComposition metricKey="hazard_confirm_outcomes" catalogue={catalogue} semantic />
          <MetricHistogram metricKey="hazard_age_at_confirm_h" catalogue={catalogue} />
        </div>
      </TuningSection>

      {/* ── Display / map ────────────────────────────────────────────────── */}
      <TuningSection
        title="Display & map"
        blurb="The displayScore curve decides which bodies draw at each zoom. Compare a band against the 256-row viewport cap — once a band holds far more than that, dense viewports at that zoom are being truncated and the curve is what to move."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ConstantCard
            name="DISPLAY_AREA_MIN_SQM"
            value={DISPLAY_AREA_MIN_SQM.toLocaleString()}
            file="display.ts"
          >
            Surface area mapping to display score 0 — a tiny pond.
          </ConstantCard>
          <ConstantCard
            name="DISPLAY_AREA_MAX_SQM"
            value={DISPLAY_AREA_MAX_SQM.toExponential(1)}
            file="display.ts"
          >
            Surface area mapping to score 1 — the largest body. The curve is log-area between these.
          </ConstantCard>
          <ConstantCard
            name="MIN_VISIBLE_ZOOM_WIDEST"
            value={MIN_VISIBLE_ZOOM_WIDEST}
            file="display.ts"
          >
            The widest (lowest) zoom a top-score body draws at.
          </ConstantCard>
          <ConstantCard
            name="MIN_VISIBLE_ZOOM_FLOOR"
            value={MIN_VISIBLE_ZOOM_FLOOR}
            file="display.ts"
          >
            The discoverability floor — every listed body is visible by this zoom, whatever its
            score.
          </ConstantCard>
        </div>
        <MetricComposition metricKey="zoom_band_distribution" catalogue={catalogue} />
      </TuningSection>

      {/* ── Report freshness (D59) ───────────────────────────────────────── */}
      <TuningSection
        title="Report freshness & path decay"
        blurb="One number decides how faded an aging report reads and how faded its recorded GPS path draws on the lake (D59) — they are the same value by construction, so they cannot drift apart. Boost-only: support extends the window, unhelpful marks never shorten it."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ConstantCard
            name="REPORT_FRESHNESS_HALF_LIFE_HOURS"
            value={`${REPORT_FRESHNESS_HALF_LIFE_HOURS}h`}
            file="reputationConfig.ts"
          >
            The decay rate: a report — and its path's opacity — loses half its freshness this often.
            Deliberately slower than the {FRESH_REPORT_HOURS}h bounty base window, because "does
            this still describe the lake" stays partly true well past "would a new report be
            welcome". Raise it and old tracks linger dark; lower it and the lake goes faint a day
            after a skate.
          </ConstantCard>
          <ConstantCard
            name="REPORT_FRESHNESS_PER_THUMB / _PER_CORROBORATION"
            value={`+${REPORT_FRESHNESS_PER_THUMB} / +${REPORT_FRESHNESS_PER_CORROBORATION}`}
            file="reputationConfig.ts"
          >
            How much each net helpful thumb, and each independent corroborating report, stretches
            the half-life. Corroboration is worth more — someone else went and looked. Capped at{' '}
            {REPORT_FRESHNESS_MAX_EXTENSION}× extra (a {1 + REPORT_FRESHNESS_MAX_EXTENSION}×
            ceiling, matching the bounty window's).
          </ConstantCard>
          <ConstantCard
            name="NET_THUMBS_MIN / NET_THUMBS_MAX"
            value={`${NET_THUMBS_MIN} … ${NET_THUMBS_MAX}`}
            file="reputationConfig.ts"
          >
            Bounds on the net-thumbs signal wherever it stretches a window — shared by the bounty
            gate and report freshness, so a change moves both together. Asymmetric: reaction can
            extend further than it can shorten.
          </ConstantCard>
          <ConstantCard
            name="REPORT_FRESHNESS_WEATHER_MULTIPLIER"
            value={`×${REPORT_FRESHNESS_WEATHER_MULTIPLIER}`}
            file="reputationConfig.ts"
          >
            What a meaningful freeze/thaw since the skate does to freshness. Multiplicative, never a
            collapse to zero — unlike the bounty gate, which should reopen outright. Weather is
            evidence about the ice, never a reason to stop showing where a person skated.
          </ConstantCard>
          <ConstantCard name="PATH_MIN_OPACITY" value={PATH_MIN_OPACITY} file="reputationConfig.ts">
            The floor a GPS path fades to but never below (D3/D58) — the same never-hide invariant
            the hazard and report layers carry. A blank stretch of lake would read as "nobody found
            a problem here"; a faint old line reads as "someone skated here a while ago".
          </ConstantCard>
        </div>
      </TuningSection>

      {/* ── Operational health ───────────────────────────────────────────── */}
      <TuningSection
        title="Operational health"
        blurb="Not tied to a constant — how the operator (you) is keeping up. Long resolution times or a growing backlog are the signal to add hands, not to move a number."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <MetricHistogram metricKey="flag_time_to_resolution_h" catalogue={catalogue} />
          <MetricHistogram metricKey="support_time_to_resolution_h" catalogue={catalogue} />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <MetricComposition metricKey="support_volume" catalogue={catalogue} />
          <MetricComposition metricKey="weather_strip_coverage" catalogue={catalogue} semantic />
        </div>
        <MetricComposition metricKey="state_coverage" catalogue={catalogue} />
      </TuningSection>
    </div>
  );
}
