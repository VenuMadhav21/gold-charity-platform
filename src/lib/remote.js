import { supabase } from './supabase';

export const DEFAULT_PRIZE_POOL = 1000;

function getPrizeTier(matches) {
  if (matches >= 5) return 'jackpot';
  if (matches === 4) return 'runner-up';
  if (matches === 3) return 'third-place';
  return null;
}

function splitAmount(total, count) {
  if (!count) return [];

  const baseShare = Math.floor(total / count);
  const remainder = total - baseShare * count;
  return Array.from({ length: count }, (_, index) => baseShare + (index < remainder ? 1 : 0));
}

export function buildDrawOutcome(users, scores, numbers, previousRollover = 0) {
  const jackpotPool = Math.round((DEFAULT_PRIZE_POOL + previousRollover) * 0.4);
  const runnerUpPool = Math.round(DEFAULT_PRIZE_POOL * 0.35);
  const thirdPlacePool = Math.round(DEFAULT_PRIZE_POOL * 0.25);

  const resultEntries = users.map((user) => {
    const scoreNumbers = scores
      .filter((score) => (score.userId ?? score.user_id) === user.id)
      .map((score) => score.score);
    const matches = numbers.filter((number) => scoreNumbers.includes(number)).length;
    const prizeTier = getPrizeTier(matches);

    return {
      id: undefined,
      user_id: user.id,
      matches,
      prizeTier,
      winnings: 0,
      verificationStatus: 'pending',
      proofUrl: '',
      proofNote: '',
      paymentStatus: 'pending',
      verifiedAt: null,
      reviewedBy: null,
    };
  });

  const jackpotWinners = resultEntries.filter((entry) => entry.prizeTier === 'jackpot');
  const runnerUpWinners = resultEntries.filter((entry) => entry.prizeTier === 'runner-up');
  const thirdPlaceWinners = resultEntries.filter((entry) => entry.prizeTier === 'third-place');

  const jackpotShares = splitAmount(jackpotPool, jackpotWinners.length);
  const runnerUpShares = splitAmount(runnerUpPool, runnerUpWinners.length);
  const thirdPlaceShares = splitAmount(thirdPlacePool, thirdPlaceWinners.length);

  let jackpotIndex = 0;
  let runnerUpIndex = 0;
  let thirdPlaceIndex = 0;

  const results = resultEntries.map((entry) => {
    let winnings = 0;

    if (entry.prizeTier === 'jackpot') {
      winnings = jackpotShares[jackpotIndex] ?? 0;
      jackpotIndex += 1;
    } else if (entry.prizeTier === 'runner-up') {
      winnings = runnerUpShares[runnerUpIndex] ?? 0;
      runnerUpIndex += 1;
    } else if (entry.prizeTier === 'third-place') {
      winnings = thirdPlaceShares[thirdPlaceIndex] ?? 0;
      thirdPlaceIndex += 1;
    }

    return {
      ...entry,
      winnings,
    };
  });

  const draw = {
    numbers,
    date: new Date().toISOString(),
    prizePool: DEFAULT_PRIZE_POOL,
    rolloverPool: previousRollover,
    jackpotPool,
    runnerUpPool,
    thirdPlacePool,
    jackpotRollover: jackpotWinners.length ? 0 : jackpotPool,
  };

  return {
    draw,
    results,
    nextRolloverPool: jackpotWinners.length ? 0 : jackpotPool,
  };
}

export const DEFAULT_CHARITIES = [
  {
    id: 'charity-hope',
    name: 'Hope Harbor',
    description: 'Supports food banks and emergency housing relief.',
  },
  {
    id: 'charity-kids',
    name: 'Bright Futures Fund',
    description: 'Funds youth education, tutoring, and school supplies.',
  },
  {
    id: 'charity-health',
    name: 'Health for All',
    description: 'Helps with clinics, screenings, and care access.',
  },
  {
    id: 'charity-earth',
    name: 'Green Earth Trust',
    description: 'Invests in clean water, conservation, and climate work.',
  },
];

function normalizeProfile(row) {
  return {
    id: row.id,
    email: row.email,
    password: '',
    role: row.role ?? 'user',
    isSubscribed: Boolean(row.is_subscribed),
    plan: row.plan ?? 'free',
    charityId: row.charity_id ?? DEFAULT_CHARITIES[0].id,
    contributionPercentage: row.contribution_percentage ?? 10,
  };
}

function normalizeScore(row) {
  return {
    id: row.id,
    userId: row.user_id,
    score: row.score,
    date: row.created_at,
  };
}

function normalizeDraw(row) {
  return {
    id: row.id,
    numbers: row.numbers ?? [],
    date: row.created_at,
    prizePool: row.prize_pool ?? DEFAULT_PRIZE_POOL,
    rolloverPool: row.rollover_pool ?? 0,
    jackpotPool: row.jackpot_pool ?? 0,
    runnerUpPool: row.runner_up_pool ?? 0,
    thirdPlacePool: row.third_place_pool ?? 0,
    jackpotRollover: row.jackpot_rollover ?? 0,
  };
}

function normalizeResult(row) {
  return {
    id: row.id,
    userId: row.user_id,
    drawId: row.draw_id,
    drawDate: row.draw_date ?? row.created_at,
    matches: row.matches,
    winnings: row.winnings,
    prizeTier: row.prize_tier ?? null,
    verificationStatus: row.verification_status ?? 'pending',
    proofUrl: row.proof_url ?? '',
    proofNote: row.proof_note ?? '',
    paymentStatus: row.payment_status ?? 'pending',
    verifiedAt: row.verified_at ?? null,
    reviewedBy: row.reviewed_by ?? null,
  };
}

export async function loadRemoteState(currentUserId) {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }

  const [profilesRes, charitiesRes, scoresRes, drawsRes, resultsRes] = await Promise.all([
    supabase.from('profiles').select('*').order('created_at', { ascending: false }),
    supabase.from('charities').select('*').order('name', { ascending: true }),
    supabase.from('scores').select('*').order('created_at', { ascending: false }),
    supabase.from('draws').select('*').order('created_at', { ascending: false }),
    supabase.from('results').select('*').order('created_at', { ascending: false }),
  ]);

  const firstError = [profilesRes, charitiesRes, scoresRes, drawsRes, resultsRes].find(
    (result) => result.error
  )?.error;
  if (firstError) {
    throw firstError;
  }

  return {
    users: (profilesRes.data ?? []).map(normalizeProfile),
    charities: (charitiesRes.data ?? []).length
      ? (charitiesRes.data ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
        }))
      : DEFAULT_CHARITIES,
    scores: (scoresRes.data ?? []).map(normalizeScore),
    draws: (drawsRes.data ?? []).map(normalizeDraw),
    results: (resultsRes.data ?? []).map(normalizeResult),
    currentUserId,
  };
}

export async function syncCurrentProfile(currentUserId, patch) {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }

  const payload = {};
  if (patch.email !== undefined) payload.email = patch.email;
  if (patch.role !== undefined) payload.role = patch.role;
  if (patch.isSubscribed !== undefined) payload.is_subscribed = patch.isSubscribed;
  if (patch.plan !== undefined) payload.plan = patch.plan;
  if (patch.charityId !== undefined) payload.charity_id = patch.charityId;
  if (patch.contributionPercentage !== undefined) {
    payload.contribution_percentage = patch.contributionPercentage;
  }

  const { error, data } = await supabase
    .from('profiles')
    .upsert(
      {
        id: currentUserId,
        ...payload,
      },
      { onConflict: 'id' }
    )
    .select('*')
    .single();

  if (error) throw error;
  return normalizeProfile(data);
}

export async function upsertRemoteCharity(charity) {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }

  const payload = {
    id: charity.id,
    name: charity.name,
    description: charity.description,
  };

  const { data, error } = await supabase
    .from('charities')
    .upsert(payload, { onConflict: 'id' })
    .select('*')
    .single();

  if (error) throw error;
  return {
    id: data.id,
    name: data.name,
    description: data.description,
  };
}

export async function deleteRemoteCharity(charityId) {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }

  const { error } = await supabase.from('charities').delete().eq('id', charityId);
  if (error) throw error;
}

export async function addRemoteScore(userId, scoreValue) {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }

  const insertRes = await supabase
    .from('scores')
    .insert({ user_id: userId, score: scoreValue })
    .select('*')
    .single();
  if (insertRes.error) throw insertRes.error;

  const allScoresRes = await supabase
    .from('scores')
    .select('id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (allScoresRes.error) throw allScoresRes.error;

  const extraScores = (allScoresRes.data ?? []).slice(5);
  if (extraScores.length) {
    const deleteRes = await supabase.from('scores').delete().in(
      'id',
      extraScores.map((row) => row.id)
    );
    if (deleteRes.error) throw deleteRes.error;
  }

  return normalizeScore(insertRes.data);
}

export async function triggerRemoteDraw() {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }

  const profilesRes = await supabase.from('profiles').select('*');
  const scoresRes = await supabase.from('scores').select('*');
  if (profilesRes.error) throw profilesRes.error;
  if (scoresRes.error) throw scoresRes.error;

  const numbers = new Set();
  while (numbers.size < 5) {
    numbers.add(Math.floor(Math.random() * 45) + 1);
  }
  const sortedNumbers = [...numbers].sort((a, b) => a - b);
  const latestDrawRes = await supabase
    .from('draws')
    .select('rollover_pool')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestDrawRes.error) throw latestDrawRes.error;

  const previousRollover = latestDrawRes.data?.rollover_pool ?? 0;
  const outcome = buildDrawOutcome(profilesRes.data ?? [], scoresRes.data ?? [], sortedNumbers, previousRollover);

  const drawRes = await supabase
    .from('draws')
    .insert({
      numbers: outcome.draw.numbers,
      prize_pool: outcome.draw.prizePool,
      rollover_pool: outcome.draw.rolloverPool,
      jackpot_pool: outcome.draw.jackpotPool,
      runner_up_pool: outcome.draw.runnerUpPool,
      third_place_pool: outcome.draw.thirdPlacePool,
      jackpot_rollover: outcome.draw.jackpotRollover,
    })
    .select('*')
    .single();
  if (drawRes.error) throw drawRes.error;

  const results = outcome.results.map((result) => ({
    user_id: result.user_id,
    draw_id: drawRes.data.id,
    draw_date: drawRes.data.created_at,
    matches: result.matches,
    winnings: result.winnings,
    prize_tier: result.prizeTier,
    verification_status: result.verificationStatus,
    proof_url: result.proofUrl,
    proof_note: result.proofNote,
    payment_status: result.paymentStatus,
    verified_at: result.verifiedAt,
    reviewed_by: result.reviewedBy,
  }));

  const resultsRes = await supabase.from('results').insert(results).select('*');
  if (resultsRes.error) throw resultsRes.error;

  return {
    draw: normalizeDraw(drawRes.data),
    results: (resultsRes.data ?? []).map(normalizeResult),
  };
}

export async function updateRemoteResult(resultId, patch) {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }

  const payload = {};
  if (patch.prizeTier !== undefined) payload.prize_tier = patch.prizeTier;
  if (patch.verificationStatus !== undefined) payload.verification_status = patch.verificationStatus;
  if (patch.proofUrl !== undefined) payload.proof_url = patch.proofUrl;
  if (patch.proofNote !== undefined) payload.proof_note = patch.proofNote;
  if (patch.paymentStatus !== undefined) payload.payment_status = patch.paymentStatus;
  if (patch.verifiedAt !== undefined) payload.verified_at = patch.verifiedAt;
  if (patch.reviewedBy !== undefined) payload.reviewed_by = patch.reviewedBy;
  if (patch.winnings !== undefined) payload.winnings = patch.winnings;

  const { data, error } = await supabase
    .from('results')
    .update(payload)
    .eq('id', resultId)
    .select('*')
    .single();

  if (error) throw error;
  return normalizeResult(data);
}
