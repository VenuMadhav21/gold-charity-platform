import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import {
  addRemoteScore,
  DEFAULT_CHARITIES,
  buildDrawOutcome,
  deleteRemoteCharity,
  loadRemoteState,
  syncCurrentProfile,
  updateRemoteResult,
  upsertRemoteCharity,
  triggerRemoteDraw,
} from './lib/remote';
import { createId, formatDate, loadState, saveState, STORAGE_KEY } from './lib/storage';

const DEFAULT_STATE = {
  users: [
    {
      id: 'admin-demo',
      email: 'admin@golfcharity.org',
      password: 'admin123',
      role: 'admin',
      isSubscribed: true,
      plan: 'monthly',
      charityId: DEFAULT_CHARITIES[0].id,
      contributionPercentage: 10,
    },
  ],
  charities: DEFAULT_CHARITIES,
  scores: [],
  draws: [],
  results: [],
  currentUserId: null,
};

function getInitialState() {
  const stored = loadState(DEFAULT_STATE);
  const storedUsers = (stored.users ?? DEFAULT_STATE.users).map((user) => ({
    ...user,
    contributionPercentage: clampContributionPercentage(user.contributionPercentage ?? 10),
  }));
  return {
    ...DEFAULT_STATE,
    ...stored,
    users: storedUsers,
    charities: stored.charities ?? DEFAULT_STATE.charities,
    scores: stored.scores ?? [],
    draws: stored.draws ?? [],
    results: stored.results ?? [],
    currentUserId: stored.currentUserId ?? DEFAULT_STATE.currentUserId,
  };
}

function generateDrawNumbers() {
  const numbers = new Set();
  while (numbers.size < 5) {
    numbers.add(Math.floor(Math.random() * 45) + 1);
  }
  return [...numbers].sort((a, b) => a - b);
}

function getPrizeTierLabel(matches) {
  if (matches >= 5) return 'Jackpot';
  if (matches === 4) return 'Runner-up';
  if (matches === 3) return 'Third place';
  return 'No prize';
}

function clampContributionPercentage(value) {
  return Math.max(10, Math.min(50, value));
}

function getSupabaseAuthMessage(error) {
  const message = error?.message || '';
  if (/email.*confirm/i.test(message)) {
    return 'Supabase requires email confirmation for this account. Confirm the email in the Supabase Auth dashboard or disable email confirmations for development.';
  }
  if (/invalid login credentials/i.test(message) || /bad request/i.test(message)) {
    return 'Invalid email or password, or the user has not been confirmed yet in Supabase Auth.';
  }
  return message || 'Unable to log in.';
}

function isSupabaseConnectivityIssue(error) {
  const message = `${error?.message || ''} ${error?.name || ''}`.toLowerCase();
  return (
    /fetch/i.test(message) ||
    /network/i.test(message) ||
    /failed to fetch/i.test(message) ||
    /timeout/i.test(message) ||
    error?.name === 'TypeError'
  );
}

function App() {
  const [state, setState] = useState(getInitialState);
  const [authForm, setAuthForm] = useState({ email: '', password: '' });
  const [scoreForm, setScoreForm] = useState('');
  const [activeSection, setActiveSection] = useState('overview');
  const [selectedPlan, setSelectedPlan] = useState('monthly');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [proofForm, setProofForm] = useState({ proofUrl: '', proofNote: '' });
  const [charityForm, setCharityForm] = useState({ id: '', name: '', description: '' });
  const [charityMode, setCharityMode] = useState('edit');
  const [authView, setAuthView] = useState(null);
  const [authMode, setAuthMode] = useState(supabase ? 'loading' : 'signedOut');

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    if (!supabase) return undefined;

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      const sessionUser = data.session?.user;
      if (!mounted || !sessionUser) {
        if (mounted) setAuthMode('signedOut');
        return;
      }

      setAuthMode('signedIn');
      setState((prev) =>
        ensureUserProfile(prev, {
          id: sessionUser.id,
          email: sessionUser.email ?? 'signed-in-user@golfcharity.org',
        })
      );
      loadRemoteState(sessionUser.id)
        .then((remoteState) => {
          if (!mounted) return;
          const nextState =
            remoteState.users?.some((user) => user.id === sessionUser.id)
              ? { ...remoteState, currentUserId: sessionUser.id }
              : ensureUserProfile(remoteState, {
                  id: sessionUser.id,
                  email: sessionUser.email ?? 'signed-in-user@golfcharity.org',
                });
          setState((prev) => ({ ...prev, ...nextState }));
        })
        .catch(() => {
          setState((prev) =>
            ensureUserProfile(prev, {
              id: sessionUser.id,
              email: sessionUser.email ?? 'signed-in-user@golfcharity.org',
            })
          );
        });
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const sessionUser = session?.user;
      if (!sessionUser) {
        setAuthMode('signedOut');
        setState((prev) => ({ ...prev, currentUserId: null }));
        return;
      }

      setAuthMode('signedIn');
      setState((prev) =>
        ensureUserProfile(prev, {
          id: sessionUser.id,
          email: sessionUser.email ?? 'signed-in-user@golfcharity.org',
        })
      );
      loadRemoteState(sessionUser.id)
        .then((remoteState) => {
          if (!mounted) return;
          const nextState =
            remoteState.users?.some((user) => user.id === sessionUser.id)
              ? { ...remoteState, currentUserId: sessionUser.id }
              : ensureUserProfile(remoteState, {
                  id: sessionUser.id,
                  email: sessionUser.email ?? 'signed-in-user@golfcharity.org',
                });
          setState((prev) => ({ ...prev, ...nextState }));
        })
        .catch(() => {
          setState((prev) =>
            ensureUserProfile(prev, {
              id: sessionUser.id,
              email: sessionUser.email ?? 'signed-in-user@golfcharity.org',
            })
          );
        });
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  function promoteAuthenticatedUser(userId, email) {
    setAuthMode('signedIn');
    setState((prev) =>
      ensureUserProfile(prev, {
        id: userId,
        email,
      })
    );
  }

  function ensureUserProfile(previousState, profile) {
    const existing = previousState.users.find((user) => user.id === profile.id);
    if (existing) {
      return { ...previousState, currentUserId: profile.id };
    }

    const newUser = {
      id: profile.id,
      email: profile.email,
      password: '',
      role: profile.email.includes('admin') ? 'admin' : 'user',
      isSubscribed: false,
      plan: 'free',
      charityId: previousState.charities?.[0]?.id ?? DEFAULT_CHARITIES[0].id,
      contributionPercentage: 10,
    };

    return {
      ...previousState,
      users: [newUser, ...previousState.users],
      currentUserId: profile.id,
    };
  }

  function findLocalUser(email, password) {
    return state.users.find(
      (user) =>
        user.email === email &&
        (user.password === password || user.id === 'admin-demo')
    );
  }

  function signInLocally(email, password, message) {
    const normalizedEmail = email.trim().toLowerCase();

    setState((prev) => {
      const existing = prev.users.find((user) => user.email === normalizedEmail);
      const nextUser = existing
        ? {
            ...existing,
            password,
            role: existing.role ?? (normalizedEmail.includes('admin') ? 'admin' : 'user'),
            isSubscribed: existing.isSubscribed ?? false,
            plan: existing.plan ?? 'free',
            charityId: existing.charityId ?? prev.charities?.[0]?.id ?? DEFAULT_CHARITIES[0].id,
            contributionPercentage: clampContributionPercentage(existing.contributionPercentage ?? 10),
          }
        : {
            id: createId('user'),
            email: normalizedEmail,
            password,
            role: normalizedEmail.includes('admin') ? 'admin' : 'user',
            isSubscribed: false,
            plan: 'free',
            charityId: prev.charities?.[0]?.id ?? DEFAULT_CHARITIES[0].id,
            contributionPercentage: 10,
          };

      const nextUsers = [
        nextUser,
        ...prev.users.filter(
          (user) => user.id !== nextUser.id && user.email !== normalizedEmail
        ),
      ];

      return {
        ...prev,
        users: nextUsers,
        currentUserId: nextUser.id,
      };
    });

    setAuthMode('signedIn');
    setAuthForm({ email: '', password: '' });
    setStatus(message);
  }

  const currentUser = state.users.find((user) => user.id === state.currentUserId) ?? null;
  const activeCharities = state.charities?.length ? state.charities : DEFAULT_CHARITIES;
  const currentUserScores = useMemo(
    () =>
      state.scores
        .filter((score) => score.userId === currentUser?.id)
        .sort((a, b) => new Date(b.date) - new Date(a.date)),
    [state.scores, currentUser?.id]
  );
  const userResults = useMemo(
    () =>
      state.results
        .filter((result) => result.userId === currentUser?.id)
        .sort((a, b) => new Date(b.drawDate) - new Date(a.drawDate)),
    [state.results, currentUser?.id]
  );
  const latestDraw = state.draws[0] ?? null;
  const latestResult = userResults[0] ?? null;
  const latestUserWinningResult = userResults.find((result) => result.matches >= 3) ?? null;
  const currentCharity =
    activeCharities.find((charity) => charity.id === currentUser?.charityId) ??
    activeCharities[0];
  const isAdmin = Boolean(currentUser?.role === 'admin');
  const showAdminControls = isAdmin;
  const isAuthenticated = authMode === 'signedIn' && Boolean(currentUser);
  const memberAccessBlocked = isAuthenticated && !isAdmin && !currentUser?.isSubscribed;
  const selectedAdminCharity =
    activeCharities.find((charity) => charity.id === charityForm.id) ?? activeCharities[0] ?? null;
  const currentUserName = (currentUser?.email ?? 'member')
    .split('@')[0]
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  useEffect(() => {
    if (!showAdminControls && activeSection === 'admin') {
      setActiveSection('overview');
    }
  }, [showAdminControls, activeSection]);

  useEffect(() => {
    if (!isAdmin || charityMode !== 'edit') return;
    const fallbackCharity = activeCharities[0];
    if (!charityForm.id && fallbackCharity) {
      setCharityForm({
        id: fallbackCharity.id,
        name: fallbackCharity.name,
        description: fallbackCharity.description,
      });
      return;
    }

    if (selectedAdminCharity) {
      setCharityForm((prev) => {
        if (prev.id !== selectedAdminCharity.id) {
          return prev;
        }
        return {
          ...prev,
          name: selectedAdminCharity.name,
          description: selectedAdminCharity.description,
        };
      });
    }
  }, [activeCharities, charityForm.id, charityMode, isAdmin, selectedAdminCharity]);

  const navItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'subscription', label: 'Subscription' },
    { id: 'charity', label: 'Charity' },
    { id: 'scores', label: 'Scores' },
    { id: 'draws', label: 'Draws' },
  ];
  if (showAdminControls) navItems.push({ id: 'admin', label: 'Admin' });

  const activeUser = currentUser ?? {
    email: '',
    isSubscribed: false,
    plan: 'free',
    role: 'user',
    charityId: activeCharities[0]?.id ?? DEFAULT_CHARITIES[0].id,
    contributionPercentage: 10,
  };

  const overviewCards = [
    {
      label: 'Subscription',
      value: activeUser.isSubscribed ? activeUser.plan : 'Free',
      helper: activeUser.isSubscribed ? 'Membership active' : 'No active plan',
    },
    {
      label: 'Charity',
      value: currentCharity?.name ?? 'None selected',
      helper: `${activeUser.contributionPercentage}% contribution`,
    },
    {
      label: 'Scores',
      value: `${currentUserScores.length}/5`,
      helper: 'Rolling score history',
    },
    {
      label: 'Latest winnings',
      value: `$${latestResult ? latestResult.winnings : 0}`,
      helper: latestResult ? `${latestResult.matches} matches` : 'No draw yet',
    },
  ];

  const adminUsers = state.users.map((user) => {
    const scoreCount = state.scores.filter((score) => score.userId === user.id).length;
    const latestUserResult = state.results
      .filter((result) => result.userId === user.id)
      .sort((a, b) => new Date(b.drawDate) - new Date(a.drawDate))[0];
    return { ...user, scoreCount, latestUserResult };
  });
  const adminLatestDrawResults = latestDraw
    ? state.results
        .filter((result) => result.drawId === latestDraw.id)
        .sort((a, b) => b.matches - a.matches || b.winnings - a.winnings)
    : [];
  const adminWinnerQueue = adminLatestDrawResults.filter(
    (result) => result.verificationStatus !== 'rejected'
  );
  const adminSummaryCards = [
    { label: 'Users', value: adminUsers.length, helper: 'Registered accounts' },
    {
      label: 'Subscribed',
      value: adminUsers.filter((user) => user.isSubscribed).length,
      helper: 'Active memberships',
    },
    {
      label: 'Winner queue',
      value: adminWinnerQueue.length,
      helper: 'Needs review',
    },
    {
      label: 'Charities',
      value: activeCharities.length,
      helper: 'Available causes',
    },
  ];

  async function handleSignUp(event) {
    event.preventDefault();
    const email = authForm.email.trim().toLowerCase();
    const password = authForm.password.trim();

    if (!email || !password) {
      setStatus('Enter email and password to create an account.');
      return;
    }

    setLoading(true);
    setStatus('');

    try {
      if (supabase) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;

        if (data.session) {
          await supabase.auth.signOut().catch(() => {});
        }

        setAuthMode('signedOut');
        setState((prev) => ({ ...prev, currentUserId: null }));
        setStatus('Account created. Check your email to confirm your account, then log in.');
      } else {
        const exists = state.users.some((user) => user.email === email);
        if (exists) throw new Error('An account with that email already exists.');

        const newUser = {
          id: createId('user'),
          email,
          password,
          role: email.includes('admin') ? 'admin' : 'user',
          isSubscribed: false,
          plan: 'free',
          charityId: activeCharities[0].id,
          contributionPercentage: 10,
        };

        setState((prev) => ({
          ...prev,
          users: [newUser, ...prev.users],
          currentUserId: newUser.id,
        }));
        setAuthMode('signedIn');
        setStatus('Account created and logged in.');
      }

      setAuthForm({ email: '', password: '' });
    } catch (error) {
      if (supabase && isSupabaseConnectivityIssue(error)) {
        console.warn('Supabase sign-up unavailable, using local session fallback.', error);
        signInLocally(email, password, 'Account created locally while Supabase was unavailable.');
        return;
      }

      setStatus(getSupabaseAuthMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function openAuthView(mode) {
    setAuthView(mode);
    setStatus('');
  }

  async function handleLogin(event) {
    event.preventDefault();
    const email = authForm.email.trim().toLowerCase();
    const password = authForm.password.trim();

    if (!email || !password) {
      setStatus('Enter email and password to log in.');
      return;
    }

    setLoading(true);
    setStatus('');

    try {
      if (supabase) {
        try {
          const { data, error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;

          const userId = data.user?.id;
          if (userId) {
            promoteAuthenticatedUser(userId, email);
            const remoteState = await loadRemoteState(userId).catch(() => null);
            if (remoteState?.users?.some((user) => user.id === userId)) {
              setState((prev) => ({ ...prev, ...remoteState, currentUserId: userId }));
            } else {
              const remoteProfile = await syncCurrentProfile(userId, {
                email,
                role: email.includes('admin') ? 'admin' : 'user',
                charityId: activeCharities[0].id,
                contributionPercentage: 10,
              });
              setState((prev) => ({
                ...prev,
                users: [
                  { ...remoteProfile, password },
                  ...prev.users.filter((user) => user.id !== userId),
                ],
                currentUserId: userId,
              }));
            }
          }
        } catch (supabaseError) {
          if (isSupabaseConnectivityIssue(supabaseError)) {
            console.warn('Supabase sign-in unavailable, using local session fallback.', supabaseError);
            signInLocally(email, password, 'Logged in locally while Supabase was unavailable.');
            return;
          }

          throw supabaseError;
        }
      } else {
        const user = state.users.find(
          (entry) => entry.email === email && entry.password === password
        );
        if (!user) throw new Error('Invalid email or password.');
        signInLocally(email, password, 'Logged in successfully.');
        return;
      }

      setStatus('Logged in successfully.');
      setAuthForm({ email: '', password: '' });
    } catch (error) {
      setStatus(getSupabaseAuthMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    try {
      setAuthMode('signedOut');
      if (supabase) {
        try {
          await supabase.auth.signOut();
        } catch (error) {
          setStatus(error.message || 'Supabase sign-out failed, clearing local session instead.');
        }
      }
      localStorage.removeItem(STORAGE_KEY);
      setState((prev) => ({
        ...prev,
        currentUserId: null,
        scores: [],
        draws: [],
        results: [],
      }));
      setAuthForm({ email: '', password: '' });
      setScoreForm('');
      setActiveSection('overview');
      setStatus('Logged out.');
      if (supabase) {
        supabase.auth.signOut().catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  }

  function updateProfile(patch) {
    if (!currentUser) return;

    const nextPatch = {
      ...patch,
    };
    if (nextPatch.contributionPercentage !== undefined) {
      nextPatch.contributionPercentage = clampContributionPercentage(nextPatch.contributionPercentage);
    }

    if (supabase) {
      syncCurrentProfile(currentUser.id, { ...nextPatch, email: currentUser.email }).catch((error) => {
        setStatus(error.message || 'Unable to save profile.');
      });
    }

    setState((prev) => ({
      ...prev,
      users: prev.users.map((user) =>
        user.id === currentUser.id ? { ...user, ...nextPatch } : user
      ),
    }));
  }

  function handleSubscribe() {
    if (!currentUser) return;

    if (supabase) {
      syncCurrentProfile(currentUser.id, {
        email: currentUser.email,
        isSubscribed: true,
        plan: selectedPlan,
      }).catch((error) => {
      setStatus(error.message || 'Unable to save subscription.');
      });
    }

    updateProfile({
      isSubscribed: true,
      plan: selectedPlan,
    });
    setStatus(`Subscription saved as ${selectedPlan}.`);
  }

  function handleAddScore(event) {
    event.preventDefault();
    if (!currentUser) return;

    const scoreValue = Number(scoreForm);
    if (!Number.isInteger(scoreValue) || scoreValue < 1 || scoreValue > 45) {
      setStatus('Enter a score between 1 and 45.');
      return;
    }

    const newScore = {
      id: createId('score'),
      userId: currentUser.id,
      score: scoreValue,
      date: new Date().toISOString(),
    };

    if (supabase) {
      addRemoteScore(currentUser.id, scoreValue).catch((error) => {
        setStatus(error.message || 'Unable to save score.');
      });
    }

    setState((prev) => {
      const userScores = prev.scores
        .filter((score) => score.userId === currentUser.id)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      const nextScores = [newScore, ...userScores].sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      );
      if (nextScores.length > 5) nextScores.pop();

      const otherScores = prev.scores.filter((score) => score.userId !== currentUser.id);
      return { ...prev, scores: [...otherScores, ...nextScores] };
    });

    setScoreForm('');
    setStatus('Score added. Only the latest 5 scores are kept.');
  }

  function handleSaveCharity(event) {
    event.preventDefault();
    if (!currentUser) return;

    if (supabase) {
      syncCurrentProfile(currentUser.id, {
        email: currentUser.email,
        charityId: currentUser.charityId,
        contributionPercentage: currentUser.contributionPercentage,
      }).catch((error) => {
        setStatus(error.message || 'Unable to save charity settings.');
      });
    }

    updateProfile({
      charityId: currentUser.charityId,
      contributionPercentage: currentUser.contributionPercentage,
    });
    setStatus('Charity settings saved.');
  }

  function handleTriggerDraw() {
    if (!currentUser || !isAdmin) return;

    if (supabase) {
      setStatus('Running draw...');
      triggerRemoteDraw()
        .then(({ draw, results }) => {
          setState((prev) => ({
            ...prev,
            draws: [draw, ...prev.draws],
            results: [...results, ...prev.results].slice(0, 200),
          }));
          setStatus(`Draw generated: ${draw.numbers.join(' - ')}.`);
        })
        .catch((error) => {
          const numbers = generateDrawNumbers();
          setState((prev) => {
            const previousRollover = prev.draws[0]?.jackpotRollover ?? 0;
            const { draw, results, nextRolloverPool } = buildDrawOutcome(
              prev.users,
              prev.scores,
              numbers,
              previousRollover
            );
            const drawRecord = {
              id: createId('draw'),
              numbers: draw.numbers,
              date: draw.date,
              prizePool: draw.prizePool,
              rolloverPool: draw.rolloverPool,
              jackpotPool: draw.jackpotPool,
              runnerUpPool: draw.runnerUpPool,
              thirdPlacePool: draw.thirdPlacePool,
              jackpotRollover: nextRolloverPool,
            };

            const resultRecords = results.map((result) => ({
              id: createId('result'),
              userId: result.user_id,
              drawId: drawRecord.id,
              drawDate: drawRecord.date,
              matches: result.matches,
              winnings: result.winnings,
              prizeTier: result.prizeTier,
              verificationStatus: result.verificationStatus,
              proofUrl: result.proofUrl,
              proofNote: result.proofNote,
              paymentStatus: result.paymentStatus,
              verifiedAt: result.verifiedAt,
              reviewedBy: result.reviewedBy,
            }));

            return {
              ...prev,
              draws: [drawRecord, ...prev.draws],
              results: [...resultRecords, ...prev.results].slice(0, 200),
            };
          });
          console.warn('Remote draw failed, local draw created instead.', error);
          setStatus('Draw generated locally.');
        });
      return;
    }

    const numbers = generateDrawNumbers();
    setState((prev) => {
      const previousRollover = prev.draws[0]?.jackpotRollover ?? 0;
      const { draw, results, nextRolloverPool } = buildDrawOutcome(
        prev.users,
        prev.scores,
        numbers,
        previousRollover
      );
      const drawRecord = {
        id: createId('draw'),
        numbers: draw.numbers,
        date: draw.date,
        prizePool: draw.prizePool,
        rolloverPool: draw.rolloverPool,
        jackpotPool: draw.jackpotPool,
        runnerUpPool: draw.runnerUpPool,
        thirdPlacePool: draw.thirdPlacePool,
        jackpotRollover: nextRolloverPool,
      };

      const resultRecords = results.map((result) => ({
        id: createId('result'),
        userId: result.user_id,
        drawId: drawRecord.id,
        drawDate: drawRecord.date,
        matches: result.matches,
        winnings: result.winnings,
        prizeTier: result.prizeTier,
        verificationStatus: result.verificationStatus,
        proofUrl: result.proofUrl,
        proofNote: result.proofNote,
        paymentStatus: result.paymentStatus,
        verifiedAt: result.verifiedAt,
        reviewedBy: result.reviewedBy,
      }));

      return {
        ...prev,
        draws: [drawRecord, ...prev.draws],
        results: [...resultRecords, ...prev.results].slice(0, 200),
      };
    });

    setStatus(`Draw generated: ${numbers.join(' - ')}.`);
  }

  function updateResultLocal(resultId, patch) {
    setState((prev) => ({
      ...prev,
      results: prev.results.map((result) =>
        result.id === resultId
          ? {
              ...result,
              ...patch,
            }
          : result
      ),
    }));
  }

  async function handleSubmitWinnerProof(event, resultId) {
    event.preventDefault();
    if (!currentUser) return;

    const proofUrl = proofForm.proofUrl.trim();
    const proofNote = proofForm.proofNote.trim();

    if (!proofUrl && !proofNote) {
      setStatus('Add a proof link or note before submitting.');
      return;
    }

    const patch = {
      proofUrl,
      proofNote,
      verificationStatus: 'pending',
    };

    if (supabase) {
      try {
        const updated = await updateRemoteResult(resultId, patch);
        updateResultLocal(resultId, updated);
      } catch (error) {
        setStatus(error.message || 'Unable to submit proof.');
        return;
      }
    } else {
      updateResultLocal(resultId, patch);
    }

    setProofForm({ proofUrl: '', proofNote: '' });
    setStatus('Proof submitted for admin review.');
  }

  async function handleReviewWinner(resultId, verificationStatus, paymentStatus) {
    if (!currentUser || !isAdmin) return;

    const patch = {
      verificationStatus,
      paymentStatus,
      verifiedAt: verificationStatus === 'approved' ? new Date().toISOString() : null,
      reviewedBy: currentUser.id,
    };

    if (supabase) {
      try {
        const updated = await updateRemoteResult(resultId, patch);
        updateResultLocal(resultId, updated);
      } catch (error) {
        setStatus(error.message || 'Unable to review winner.');
        return;
      }
    } else {
      updateResultLocal(resultId, patch);
    }

    setStatus(`Winner marked as ${verificationStatus}.`);
  }

  async function handleAdminUpdateUser(userId, patch) {
    if (!isAdmin) return;

    if (supabase) {
      try {
        await syncCurrentProfile(userId, { ...patch, email: user.email });
      } catch (error) {
        setStatus(error.message || 'Unable to update user.');
        return;
      }
    }

    setState((prev) => ({
      ...prev,
      users: prev.users.map((user) =>
        user.id === userId
          ? {
              ...user,
              ...patch,
            }
          : user
      ),
    }));

    setStatus('User updated.');
  }

  async function handleSaveCharityAdmin(event) {
    event.preventDefault();
    if (!isAdmin) return;

    const id = charityForm.id.trim() || `charity-${Date.now().toString(36)}`;
    const name = charityForm.name.trim();
    const description = charityForm.description.trim();

    if (!name || !description) {
      setStatus('Enter a charity name and description.');
      return;
    }

    const nextCharity = { id, name, description };

    if (supabase) {
      try {
        const saved = await upsertRemoteCharity(nextCharity);
        setState((prev) => ({
          ...prev,
          charities: [
            saved,
            ...prev.charities.filter((charity) => charity.id !== saved.id),
          ].sort((a, b) => a.name.localeCompare(b.name)),
        }));
      } catch (error) {
        setStatus(error.message || 'Unable to save charity.');
        return;
      }
    } else {
      setState((prev) => ({
        ...prev,
        charities: [
          nextCharity,
          ...prev.charities.filter((charity) => charity.id !== nextCharity.id),
        ].sort((a, b) => a.name.localeCompare(b.name)),
      }));
    }

    setCharityForm(nextCharity);
    setCharityMode('edit');
    setStatus('Charity saved.');
  }

  async function handleDeleteCharity(charityId) {
    if (!isAdmin) return;
    if (activeCharities.length <= 1) {
      setStatus('Keep at least one charity available.');
      return;
    }

    const charityToDelete = activeCharities.find((charity) => charity.id === charityId);
    if (!charityToDelete) return;

    const replacementId = activeCharities.find((charity) => charity.id !== charityId)?.id;

    if (supabase) {
      try {
        if (replacementId) {
          const { error: reassignmentError } = await supabase
            .from('profiles')
            .update({ charity_id: replacementId })
            .eq('charity_id', charityId);
          if (reassignmentError) throw reassignmentError;
        }
        await deleteRemoteCharity(charityId);
      } catch (error) {
        setStatus(error.message || 'Unable to delete charity.');
        return;
      }
    }

    setState((prev) => ({
      ...prev,
      charities: prev.charities.filter((charity) => charity.id !== charityId),
      users: prev.users.map((user) =>
        user.charityId === charityId
          ? { ...user, charityId: replacementId ?? user.charityId }
          : user
      ),
    }));

    if (currentUser?.charityId === charityId && replacementId) {
      updateProfile({ charityId: replacementId });
    }

    setCharityForm((prev) =>
      prev.id === charityId
        ? {
            id: replacementId ?? '',
            name: '',
            description: '',
          }
        : prev
    );
    setCharityMode('edit');
    setStatus(`Deleted ${charityToDelete.name}.`);
  }

  if (memberAccessBlocked) {
    return (
      <div className="shell auth-shell">
        <section className="auth-hero auth-hero--split">
          <div className="auth-hero-top">
            <div className="brand-lockup brand-lockup--hero">
              <span className="brand-mark">GC</span>
              <div>
                <p>Golf Charity Platform</p>
                <strong>Membership required.</strong>
              </div>
            </div>
            <div className="auth-actions">
              <button type="button" className="secondary" onClick={() => setAuthView(null)}>
                Back to home
              </button>
            </div>
          </div>

          <div className="auth-page-grid">
            <div className="auth-hero-copy auth-page-copy">
              <span className="eyebrow">Blocked access</span>
              <h1>Your dashboard opens after you subscribe.</h1>
              <p className="hero-copy">
                Choose a plan, subscribe, and your dashboard unlocks immediately.
              </p>
              <div className="callout-grid auth-callouts">
                <div className="callout">
                  <strong>Current status</strong>
                  <span>Not subscribed</span>
                  <span>Dashboard access paused</span>
                </div>
              </div>
            </div>

            <section className="auth-card-wrap">
              <section className="panel auth-panel">
                <div className="auth-panel-head">
                  <h2>Activate membership</h2>
                  <p>Choose a plan to unlock scores, draws, and charity controls.</p>
                </div>
                <div className="subscribe-row">
                  <select
                    value={selectedPlan}
                    onChange={(event) => setSelectedPlan(event.target.value)}
                  >
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                  <button className="primary" onClick={handleSubscribe}>
                    Subscribe
                  </button>
                </div>
                <p className="muted">Minimum contribution is 10% for every active member.</p>
              </section>
            </section>
          </div>
        </section>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (authView === 'login' || authView === 'signup') {
      return (
        <div className="shell auth-shell auth-shell--auth">
          <section className="auth-hero auth-hero--split">
            <div className="auth-hero-top">
              <div className="brand-lockup brand-lockup--hero">
                <span className="brand-mark">GC</span>
                <div>
                  <p>Golf Charity Platform</p>
                  <strong>Member access portal</strong>
                </div>
              </div>
              <div className="auth-actions">
                <button type="button" className="secondary" onClick={() => setAuthView(null)}>
                  Back to home
                </button>
                <button
                  type="button"
                  className={authView === 'login' ? 'primary' : 'secondary'}
                  onClick={() => setAuthView('login')}
                >
                  Log in
                </button>
                <button
                  type="button"
                  className={authView === 'signup' ? 'primary' : 'secondary'}
                  onClick={() => setAuthView('signup')}
                >
                  Sign up
                </button>
              </div>
            </div>

            <div className="auth-page-grid">
              <div className="auth-hero-copy auth-page-copy">
                <span className="eyebrow">
                  {authView === 'login' ? 'Welcome back' : 'Join the workspace'}
                </span>
                <h1>
                  {authView === 'login'
                    ? 'Log in to open your dashboard.'
                    : 'Create your account and confirm by email.'}
                </h1>
                <p className="hero-copy">
                  {authView === 'login'
                    ? 'Use your existing email and password to continue into the member workspace.'
                    : 'Sign up, confirm the email link from Supabase, then log in to reach the dashboard.'}
                </p>
                {authView === 'login' ? (
                  <div className="callout-grid auth-callouts">
                    <div className="callout">
                      <strong>Demo admin</strong>
                      <span>admin@golfcharity.org</span>
                      <span>admin123</span>
                    </div>
                  </div>
                ) : null}
              </div>

              <section className="auth-card-wrap">
                <form
                  className="panel auth-panel"
                  onSubmit={authView === 'login' ? handleLogin : handleSignUp}
                >
                  <div className="auth-panel-head">
                    <h2>{authView === 'login' ? 'Log in' : 'Sign up'}</h2>
                    <p>
                      {authView === 'login'
                        ? 'Enter your credentials to continue.'
                        : 'Create a new account to get started.'}
                    </p>
                  </div>
                  <label>
                    Email
                    <input
                      type="email"
                      value={authForm.email}
                      onChange={(event) =>
                        setAuthForm((prev) => ({ ...prev, email: event.target.value }))
                      }
                      placeholder="you@example.com"
                    />
                  </label>
                  <label>
                    Password
                    <input
                      type="password"
                      value={authForm.password}
                      onChange={(event) =>
                        setAuthForm((prev) => ({ ...prev, password: event.target.value }))
                      }
                      placeholder="••••••••"
                    />
                  </label>
                  <div className="button-row">
                    <button type="submit" className="primary" disabled={loading}>
                      {authView === 'login' ? 'Log in' : 'Sign up'}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setAuthView(null)}
                      disabled={loading}
                    >
                      Back
                    </button>
                  </div>
                  {status ? <p className="status">{status}</p> : null}
                </form>
              </section>
            </div>
          </section>
        </div>
      );
    }

    return (
      <div className="shell auth-shell">
        <section className="auth-hero">
          <div className="auth-hero-top">
            <div className="brand-lockup brand-lockup--hero">
              <span className="brand-mark">GC</span>
              <div>
                <p>Golf Charity Platform</p>
                <strong>Membership, scores, and charitable draws.</strong>
              </div>
            </div>
            <div className="auth-actions">
              <button type="button" className="secondary" onClick={() => openAuthView('login')}>
                Log in
              </button>
              <button type="button" className="primary" onClick={() => openAuthView('signup')}>
                Sign up
              </button>
            </div>
          </div>

          <div className="auth-hero-copy">
            <span className="eyebrow">Private beta workspace</span>
            <h1>A modern golf charity platform built for subscriptions, scores, and draws.</h1>
            <p className="hero-copy">
              Clean product interface for subscribers, clear charity allocation, rolling score
              management, and monthly draw visibility.
            </p>
          </div>

          <div className="feature-strip">
            <span>Subscription tracking</span>
            <span>Charity allocation</span>
            <span>Monthly draw results</span>
          </div>

          <div className="callout-grid auth-callouts">
            <div className="callout">
              <strong>Demo admin</strong>
              <span>admin@golfcharity.org</span>
              <span>admin123</span>
            </div>
            <div className="callout">
              <strong>Score rule</strong>
              <span>Only the latest 5 scores are retained per user.</span>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="shell app-shell">
      <div className="workspace-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-lockup brand-lockup--sidebar">
              <span className="brand-mark">GC</span>
              <div>
                <p>Golf Charity Platform</p>
                <strong>Member workspace</strong>
              </div>
            </div>
          </div>

          <div className="sidebar-card">
            <span className="label">Current account</span>
            <strong>{currentUser.role === 'admin' ? 'Administrator' : 'Member'}</strong>
            <span className="pill">{activeUser.isSubscribed ? activeUser.plan : 'Free access'}</span>
          </div>

          <nav className="sidebar-nav" aria-label="Dashboard sections">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={activeSection === item.id ? 'nav-item active' : 'nav-item'}
                onClick={() => setActiveSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="sidebar-card sidebar-actions">
            <span className="label">Quick status</span>
            <strong>{activeUser.isSubscribed ? activeUser.plan : 'Free access'}</strong>
            <button type="button" className="secondary" onClick={handleLogout} disabled={loading}>
              Log out
            </button>
          </div>
        </aside>

        <section className="content-shell">
          <section className="brand-spotlight">
            <div>
              <span className="eyebrow">Golf Charity Platform</span>
              <h2>Built for subscriptions, scores, and charity operations.</h2>
            </div>
          </section>

          <header className="topbar compact">
            <div>
              <div className="badge-row">
                <span className="badge brand">Golf Charity Platform</span>
                <span className="badge">Live ops dashboard</span>
              </div>
              <h1>{activeSection === 'admin' ? 'Admin Control Center' : `Welcome, ${currentUserName}`}</h1>
              <p>
                {activeSection === 'admin'
                  ? 'Manage users, run draws, and review participation in one place.'
                  : 'Track your membership, manage your charity allocation, and review draw results.'}
              </p>
            </div>
            <div className="topbar-actions">
              <span className={activeUser.isSubscribed ? 'pill good' : 'pill warning'}>
                {activeUser.isSubscribed ? `Subscribed - ${activeUser.plan}` : 'Not subscribed'}
              </span>
              <span className="pill">{currentUserScores.length}/5 scores</span>
            </div>
          </header>

          {status ? <div className="notice">{status}</div> : null}

          <section className="metrics-grid">
            {overviewCards.map((card) => (
              <article key={card.label} className="metric-card">
                <span className="label">{card.label}</span>
                <strong>{card.value}</strong>
                <p>{card.helper}</p>
              </article>
            ))}
          </section>

          {activeSection === 'overview' ? (
            <div className="content-grid">
              <section className="panel panel-accent">
                <div className="panel-header">
                  <h2>Membership Overview</h2>
                  <span className="pill">{activeUser.isSubscribed ? 'Active' : 'Pending'}</span>
                </div>
                <p>
                  Subscription status is stored in the database and controls access to member features.
                </p>
                <div className="form-inline">
                  <select value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                  <button className="primary" onClick={handleSubscribe}>
                    Subscribe
                  </button>
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h2>Draw Snapshot</h2>
                  <span className="pill">{latestDraw ? formatDate(latestDraw.date) : 'Waiting for draw'}</span>
                </div>
                {latestDraw ? (
                  <div className="draw-box">
                    <p>
                      Draw numbers: <strong>{latestDraw.numbers.join(' • ')}</strong>
                    </p>
                    <p>
                      Matching scores: <strong>{latestResult ? latestResult.matches : 0}</strong>
                    </p>
                    <p>
                      Winnings: <strong>${latestResult ? latestResult.winnings : 0}</strong>
                    </p>
                  </div>
                ) : (
                  <p className="muted">No draw has been triggered yet.</p>
                )}
              </section>
            </div>
          ) : null}

          {activeSection === 'subscription' ? (
            <section className="panel">
              <div className="panel-header">
                <h2>Subscription</h2>
                <span className={activeUser.isSubscribed ? 'pill good' : 'pill warning'}>
                  {activeUser.isSubscribed ? `Subscribed - ${activeUser.plan}` : 'Not subscribed'}
                </span>
              </div>
              <p>Subscription status is stored in the database and controls access to member features.</p>
              <div className="form-inline">
                <select value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
                <button className="primary" onClick={handleSubscribe}>
                  Subscribe
                </button>
              </div>
            </section>
          ) : null}

          {activeSection === 'charity' ? (
            <section className="panel">
              <div className="panel-header">
                <h2>Charity Allocation</h2>
                <span className="pill">{currentCharity?.name ?? 'No charity selected'}</span>
              </div>
              <form onSubmit={handleSaveCharity} className="stack">
                <label>
                  Charity
                  <select
                    value={currentUser.charityId}
                    onChange={(event) => updateProfile({ charityId: event.target.value })}
                  >
                    {activeCharities.map((charity) => (
                      <option key={charity.id} value={charity.id}>
                        {charity.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Contribution percentage: {currentUser.contributionPercentage}%
                  <input
                    type="range"
                    min="10"
                    max="50"
                    value={currentUser.contributionPercentage}
                    onChange={(event) =>
                      updateProfile({ contributionPercentage: Number(event.target.value) })
                    }
                  />
                </label>
                <button className="secondary" type="submit">
                  Save allocation
                </button>
              </form>
              {currentCharity ? <p className="muted">{currentCharity.description}</p> : null}
              <p className="muted">Minimum contribution is 10%.</p>
            </section>
          ) : null}

          {activeSection === 'scores' ? (
            <section className="panel">
              <div className="panel-header">
                <h2>Score History</h2>
                <span className="pill">{currentUserScores.length}/5 stored</span>
              </div>
              <form className="form-inline" onSubmit={handleAddScore}>
                <input
                  type="number"
                  min="1"
                  max="45"
                  value={scoreForm}
                  onChange={(event) => setScoreForm(event.target.value)}
                  placeholder="Add a score"
                />
                <button className="primary" type="submit">
                  Add score
                </button>
              </form>
              <div className="score-list">
                {currentUserScores.length ? (
                  currentUserScores.map((score) => (
                    <div key={score.id} className="score-row">
                      <strong>{score.score}</strong>
                      <span>{formatDate(score.date)}</span>
                    </div>
                  ))
                ) : (
                  <p className="muted">No scores yet. Add one to start your draw history.</p>
                )}
              </div>
            </section>
          ) : null}

          {activeSection === 'draws' ? (
            <section className="panel">
              <div className="panel-header">
                <h2>Latest Draw</h2>
                <span className="pill">{latestDraw ? formatDate(latestDraw.date) : 'Waiting for draw'}</span>
              </div>
              {latestDraw ? (
                <div className="draw-box">
                  <p>
                    Draw numbers: <strong>{latestDraw.numbers.join(' • ')}</strong>
                  </p>
                  <p>
                    Matching scores: <strong>{latestResult ? latestResult.matches : 0}</strong>
                  </p>
                  <p>
                    Prize tier: <strong>{latestResult ? getPrizeTierLabel(latestResult.matches) : 'No prize'}</strong>
                  </p>
                  <p>
                    Winnings: <strong>${latestResult ? latestResult.winnings : 0}</strong>
                  </p>
                  <p>
                    Jackpot rollover: <strong>${latestDraw.jackpotRollover ?? 0}</strong>
                  </p>
                </div>
              ) : (
                <p className="muted">No draw has been triggered yet.</p>
              )}
              {latestUserWinningResult ? (
                <form
                  className="stack"
                  onSubmit={(event) => handleSubmitWinnerProof(event, latestUserWinningResult.id)}
                >
                  <h3>Winner proof</h3>
                  <p className="muted">
                    Upload proof for your latest winning result. Admin will approve or reject it.
                  </p>
                  <label>
                    Proof link
                    <input
                      type="url"
                      value={proofForm.proofUrl}
                      onChange={(event) =>
                        setProofForm((prev) => ({ ...prev, proofUrl: event.target.value }))
                      }
                      placeholder="https://..."
                    />
                  </label>
                  <label>
                    Notes
                    <textarea
                      rows="3"
                      value={proofForm.proofNote}
                      onChange={(event) =>
                        setProofForm((prev) => ({ ...prev, proofNote: event.target.value }))
                      }
                      placeholder="Add payment details or verification notes"
                    />
                  </label>
                  <button className="secondary" type="submit">
                    Submit proof
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}

          {showAdminControls && activeSection === 'admin' ? (
            <section className="panel full-width">
              <div className="panel-header">
                <h2>Admin Panel</h2>
                <button type="button" className="primary" onClick={handleTriggerDraw} disabled={!isAdmin}>
                  Trigger draw
                </button>
              </div>
              <section className="admin-summary-grid">
                {adminSummaryCards.map((card) => (
                  <article key={card.label} className="metric-card admin-summary-card">
                    <span className="label">{card.label}</span>
                    <strong>{card.value}</strong>
                    <p>{card.helper}</p>
                  </article>
                ))}
              </section>
              <div className="admin-grid">
                <div className="admin-section-card">
                  <div className="panel-header">
                    <div>
                      <h3>User Management</h3>
                      <p className="muted">Update subscription and access roles.</p>
                    </div>
                    <span className="pill">{adminUsers.length} users</span>
                  </div>
                  <div className="table">
                    {adminUsers.map((user) => (
                      <div key={user.id} className="table-row">
                        <div>
                          <strong>{user.email}</strong>
                          <span>{user.role}</span>
                        </div>
                        <div>
                          <span>{user.isSubscribed ? user.plan : 'free'}</span>
                          <span>{user.scoreCount} scores</span>
                        </div>
                        <div>
                          <span>{activeCharities.find((item) => item.id === user.charityId)?.name ?? 'No charity'}</span>
                          <span>${user.latestUserResult?.winnings ?? 0} latest winnings</span>
                        </div>
                        <div className="button-row">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              handleAdminUpdateUser(user.id, {
                                isSubscribed: !user.isSubscribed,
                                plan: !user.isSubscribed ? 'monthly' : 'free',
                              })
                            }
                          >
                            {user.isSubscribed ? 'Unset sub' : 'Set sub'}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              handleAdminUpdateUser(user.id, {
                                role: user.role === 'admin' ? 'user' : 'admin',
                              })
                            }
                          >
                            {user.role === 'admin' ? 'Make user' : 'Make admin'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="admin-section-card">
                  <div className="panel-header">
                    <div>
                      <h3>Recent Draws</h3>
                      <p className="muted">Latest completed draws and payout snapshots.</p>
                    </div>
                  </div>
                  <div className="admin-draw-list">
                    {state.draws.length ? (
                      state.draws.slice(0, 5).map((draw) => (
                        <article key={draw.id} className="admin-draw-card">
                          <strong>{draw.numbers.join(' • ')}</strong>
                          <span>{formatDate(draw.date)}</span>
                        </article>
                      ))
                    ) : (
                      <p className="muted">No draws have been run yet.</p>
                    )}
                  </div>
                </div>
                <div className="admin-section-card">
                  <div className="panel-header">
                    <div>
                      <h3>Charity Manager</h3>
                      <p className="muted">Add, edit, and remove charities.</p>
                    </div>
                    <span className="pill">{activeCharities.length} charities</span>
                  </div>
                  <div className="admin-charity-grid">
                    <form className="stack" onSubmit={handleSaveCharityAdmin}>
                      <div className="panel-mini">
                        <span className="label">Selected charity</span>
                        <strong>{selectedAdminCharity?.name ?? 'New charity'}</strong>
                        <p>{selectedAdminCharity?.description ?? 'Create a new charity entry.'}</p>
                      </div>
                      <label>
                        Choose charity
                        <select
                          value={charityForm.id}
                          onChange={(event) => {
                            const charity = activeCharities.find((item) => item.id === event.target.value);
                            setCharityMode('edit');
                            setCharityForm({
                              id: charity?.id ?? '',
                              name: charity?.name ?? '',
                              description: charity?.description ?? '',
                            });
                          }}
                        >
                          <option value="">New charity</option>
                          {activeCharities.map((charity) => (
                            <option key={charity.id} value={charity.id}>
                              {charity.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Charity name
                        <input
                          type="text"
                          value={charityForm.name}
                          onChange={(event) =>
                            setCharityForm((prev) => ({ ...prev, name: event.target.value }))
                          }
                          placeholder="Charity name"
                        />
                      </label>
                      <label>
                        Description
                        <textarea
                          rows="3"
                          value={charityForm.description}
                          onChange={(event) =>
                            setCharityForm((prev) => ({ ...prev, description: event.target.value }))
                          }
                          placeholder="Charity description"
                        />
                      </label>
                      <div className="button-row">
                        <button className="primary" type="submit">
                          Save charity
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setCharityMode('new');
                            setCharityForm({
                              id: '',
                              name: '',
                              description: '',
                            });
                          }}
                        >
                          New charity
                        </button>
                      </div>
                    </form>
                    <div className="stack charity-list">
                      {activeCharities.map((charity) => (
                        <div key={charity.id} className="charity-card">
                          <div>
                            <strong>{charity.name}</strong>
                            <p>{charity.description}</p>
                          </div>
                          <div className="button-row">
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setCharityMode('edit');
                                setCharityForm({
                                  id: charity.id,
                                  name: charity.name,
                                  description: charity.description,
                                });
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => handleDeleteCharity(charity.id)}
                              disabled={activeCharities.length <= 1}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="admin-section-card">
                  <div className="panel-header">
                    <div>
                      <h3>Winner Verification</h3>
                      <p className="muted">Review proof and mark payment status.</p>
                    </div>
                    <span className="pill">{adminWinnerQueue.length} in queue</span>
                  </div>
                  <div className="admin-review-list">
                    {adminWinnerQueue.length ? (
                      adminWinnerQueue.map((result) => {
                        const winner = adminUsers.find((user) => user.id === result.userId);
                        return (
                          <article key={result.id} className="admin-review-card">
                            <div className="admin-review-top">
                              <div>
                                <strong>{winner?.email ?? 'Unknown user'}</strong>
                                <p>
                                  {getPrizeTierLabel(result.matches)} - ${result.winnings}
                                </p>
                              </div>
                              <div className="admin-review-badges">
                                <span className="pill">{result.verificationStatus}</span>
                                <span className="pill">{result.paymentStatus}</span>
                              </div>
                            </div>
                            <div className="admin-review-body">
                              <p>Proof: {result.proofUrl || 'No proof link yet'}</p>
                              <p>Note: {result.proofNote || 'No note provided'}</p>
                            </div>
                            <div className="button-row">
                              <button
                                type="button"
                                className="primary"
                                onClick={() =>
                                  handleReviewWinner(result.id, 'approved', 'pending')
                                }
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                onClick={() =>
                                  handleReviewWinner(result.id, 'rejected', 'pending')
                                }
                              >
                                Reject
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => handleReviewWinner(result.id, 'approved', 'paid')}
                              >
                                Mark payout
                              </button>
                            </div>
                          </article>
                        );
                      })
                    ) : (
                      <p className="muted">No winner submissions are available yet.</p>
                    )}
                  </div>
                </div>
              </div>
            </section>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export default App;
