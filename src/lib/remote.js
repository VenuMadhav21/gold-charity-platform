import { supabase } from './supabase';

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

  const numbers = new Set();
  while (numbers.size < 5) {
    numbers.add(Math.floor(Math.random() * 45) + 1);
  }
  const sortedNumbers = [...numbers].sort((a, b) => a - b);

  const profilesRes = await supabase.from('profiles').select('*');
  const scoresRes = await supabase.from('scores').select('*');
  if (profilesRes.error) throw profilesRes.error;
  if (scoresRes.error) throw scoresRes.error;

  const drawRes = await supabase
    .from('draws')
    .insert({ numbers: sortedNumbers })
    .select('*')
    .single();
  if (drawRes.error) throw drawRes.error;

  const results = (profilesRes.data ?? []).map((profile) => {
    const userScores = (scoresRes.data ?? [])
      .filter((score) => score.user_id === profile.id)
      .map((score) => score.score);
    const matches = sortedNumbers.filter((number) => userScores.includes(number)).length;
    const winnings = matches ? (profile.is_subscribed ? matches * 50 : matches * 25) : 0;

    return {
      user_id: profile.id,
      draw_id: drawRes.data.id,
      draw_date: drawRes.data.created_at,
      matches,
      winnings,
    };
  });

  const resultsRes = await supabase.from('results').insert(results).select('*');
  if (resultsRes.error) throw resultsRes.error;

  return {
    draw: normalizeDraw(drawRes.data),
    results: (resultsRes.data ?? []).map(normalizeResult),
  };
}
