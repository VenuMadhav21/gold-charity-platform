import { useEffect, useMemo, useState } from 'react';
import { hasSupabaseConfig, supabase } from './lib/supabase';
import {
  addRemoteScore,
  DEFAULT_CHARITIES,
  loadRemoteState,
  syncCurrentProfile,
  triggerRemoteDraw,
} from './lib/remote';
import { createId, formatDate, loadState, saveState } from './lib/storage';

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
  return {
    ...DEFAULT_STATE,
    ...stored,
    users: stored.users ?? DEFAULT_STATE.users,
    charities: stored.charities ?? DEFAULT_STATE.charities,
    scores: stored.scores ?? [],
    draws: stored.draws ?? [],
    results: stored.results ?? [],
    currentUserId: stored.currentUserId ?? DEFAULT_STATE.currentUserId,
  };
}

function calculateWinnings(matches, subscribed) {
  if (!matches) return 0;
  const base = matches * 25;
  return subscribed ? base * 2 : base;
}

function generateDrawNumbers() {
  const numbers = new Set();
  while (numbers.size < 5) {
    numbers.add(Math.floor(Math.random() * 45) + 1);
  }
  return [...numbers].sort((a, b) => a - b);
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

function App() {
  const [state, setState] = useState(getInitialState);
  const [authForm, setAuthForm] = useState({ email: '', password: '' });
  const [scoreForm, setScoreForm] = useState('');
  const [activeSection, setActiveSection] = useState('overview');
  const [selectedPlan, setSelectedPlan] = useState('monthly');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    if (!supabase) return undefined;

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      const sessionUser = data.session?.user;
      if (!mounted || !sessionUser) return;

      loadRemoteState(sessionUser.id)
        .then((remoteState) => {
          if (mounted) setState((prev) => ({ ...prev, ...remoteState }));
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
        setState((prev) => ({ ...prev, currentUserId: null }));
        return;
      }

      loadRemoteState(sessionUser.id)
        .then((remoteState) => {
          if (mounted) setState((prev) => ({ ...prev, ...remoteState }));
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

  const currentUser = state.users.find((user) => user.id === state.currentUserId) ?? null;
  const isAdmin = Boolean(currentUser?.role === 'admin');
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
  const currentCharity =
    activeCharities.find((charity) => charity.id === currentUser?.charityId) ??
    activeCharities[0];
  const showAdminControls = isAdmin;

  useEffect(() => {
    if (!showAdminControls && activeSection === 'admin') {
      setActiveSection('overview');
    }
  }, [showAdminControls, activeSection]);

  const navItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'subscription', label: 'Subscription' },
    { id: 'charity', label: 'Charity' },
    { id: 'scores', label: 'Scores' },
    { id: 'draws', label: 'Draws' },
  ];
  if (showAdminControls) navItems.push({ id: 'admin', label: 'Admin' });

  const overviewCards = [
    {
      label: 'Subscription',
      value: currentUser.isSubscribed ? currentUser.plan : 'Free',
      helper: currentUser.isSubscribed ? 'Membership active' : 'No active plan',
    },
    {
      label: 'Charity',
      value: currentCharity?.name ?? 'None selected',
      helper: `${currentUser.contributionPercentage}% contribution`,
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

        const userId = data.user?.id;
        if (userId) {
          const remoteProfile = await syncCurrentProfile(userId, {
            email,
            role: email.includes('admin') ? 'admin' : 'user',
            charityId: activeCharities[0].id,
            contributionPercentage: 10,
          });
          setState((prev) => ({
            ...prev,
            users: [remoteProfile, ...prev.users.filter((user) => user.id !== userId)],
            currentUserId: userId,
          }));
        }
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
      }

      setStatus('Account created and logged in.');
      setAuthForm({ email: '', password: '' });
    } catch (error) {
      setStatus(getSupabaseAuthMessage(error));
    } finally {
      setLoading(false);
    }
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
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;

        const userId = data.user?.id;
        if (userId) {
          const remoteState = await loadRemoteState(userId);
          setState((prev) => ({ ...prev, ...remoteState }));
        }
      } else {
        const user = state.users.find(
          (entry) => entry.email === email && entry.password === password
        );
        if (!user) throw new Error('Invalid email or password.');
        setState((prev) => ({ ...prev, currentUserId: user.id }));
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
      if (supabase) {
        await supabase.auth.signOut();
      }
      setState((prev) => ({ ...prev, currentUserId: null }));
      setStatus('Logged out.');
    } finally {
      setLoading(false);
    }
  }

  function updateProfile(patch) {
    if (!currentUser) return;

    if (supabase) {
      syncCurrentProfile(currentUser.id, patch).catch((error) => {
        setStatus(error.message || 'Unable to save profile.');
      });
    }

    setState((prev) => ({
      ...prev,
      users: prev.users.map((user) =>
        user.id === currentUser.id ? { ...user, ...patch } : user
      ),
    }));
  }

  function handleSubscribe() {
    if (!currentUser) return;

    if (supabase) {
      syncCurrentProfile(currentUser.id, {
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
    if (!isAdmin) return;

    if (supabase) {
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
          setStatus(error.message || 'Unable to trigger draw.');
        });
      return;
    }

    const numbers = generateDrawNumbers();
    const draw = {
      id: createId('draw'),
      numbers,
      date: new Date().toISOString(),
    };

    setState((prev) => {
      const nextResults = prev.users.map((user) => {
        const scoreNumbers = prev.scores
          .filter((score) => score.userId === user.id)
          .map((score) => score.score);
        const matches = numbers.filter((number) => scoreNumbers.includes(number)).length;

        return {
          id: createId('result'),
          userId: user.id,
          drawId: draw.id,
          drawDate: draw.date,
          matches,
          winnings: calculateWinnings(matches, user.isSubscribed),
        };
      });

      return {
        ...prev,
        draws: [draw, ...prev.draws],
        results: [...nextResults, ...prev.results].slice(0, 200),
      };
    });

    setStatus(`Draw generated: ${numbers.join(' - ')}.`);
  }

  if (!currentUser) {
    return (
      <div className="shell auth-shell">
        <section className="hero-card">
          <div className="badge-row">
            <span className="badge brand">Golf Charity Platform</span>
            <span className="badge">
              Supabase ready{hasSupabaseConfig ? '' : ' - local demo mode'}
            </span>
          </div>
          <h1>A modern golf charity platform built for subscriptions, scores, and draws.</h1>
          <p className="hero-copy">
            Clean product interface for subscribers, clear charity allocation, rolling score
            management, and monthly draw visibility.
          </p>
          <div className="callout-grid">
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
          <div className="feature-strip">
            <span>Subscription tracking</span>
            <span>Charity allocation</span>
            <span>Monthly draw results</span>
          </div>
        </section>

        <form className="panel auth-panel" onSubmit={handleLogin}>
          <h2>Sign in or create an account</h2>
          <label>
            Email
            <input
              type="email"
              value={authForm.email}
              onChange={(event) => setAuthForm((prev) => ({ ...prev, email: event.target.value }))}
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
              Log in
            </button>
            <button type="button" className="secondary" onClick={handleSignUp} disabled={loading}>
              Sign up
            </button>
          </div>
          {status ? <p className="status">{status}</p> : null}
        </form>
      </div>
    );
  }

  return (
    <div className="shell app-shell">
      <div className="workspace-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="badge brand">Golf Charity Platform</div>
            <p>Modern membership workspace</p>
          </div>

          <div className="sidebar-card">
            <span className="label">Signed in as</span>
            <strong>{currentUser.email}</strong>
            <span className="pill">{currentUser.role === 'admin' ? 'Administrator' : 'Member'}</span>
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
            <strong>{currentUser.isSubscribed ? currentUser.plan : 'Free access'}</strong>
            <button className="secondary" onClick={handleLogout} disabled={loading}>
              Log out
            </button>
          </div>
        </aside>

        <section className="content-shell">
          <header className="topbar compact">
            <div>
              <div className="badge-row">
                <span className="badge">{currentUser.role === 'admin' ? 'Admin' : 'Member'}</span>
                <span className="badge">Stableford scoring</span>
              </div>
              <h1>{activeSection === 'admin' ? 'Admin Control Center' : 'Member Dashboard'}</h1>
              <p>
                {activeSection === 'admin'
                  ? 'Manage users, run draws, and review participation in one place.'
                  : 'Track your membership, manage your charity allocation, and review draw results.'}
              </p>
            </div>
            <div className="topbar-actions">
              <span className={currentUser.isSubscribed ? 'pill good' : 'pill warning'}>
                {currentUser.isSubscribed ? `Subscribed - ${currentUser.plan}` : 'Not subscribed'}
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
                  <span className="pill">{currentUser.isSubscribed ? 'Active' : 'Pending'}</span>
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
                <span className={currentUser.isSubscribed ? 'pill good' : 'pill warning'}>
                  {currentUser.isSubscribed ? `Subscribed - ${currentUser.plan}` : 'Not subscribed'}
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
                    min="1"
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
                    Winnings: <strong>${latestResult ? latestResult.winnings : 0}</strong>
                  </p>
                </div>
              ) : (
                <p className="muted">No draw has been triggered yet.</p>
              )}
            </section>
          ) : null}

          {showAdminControls && activeSection === 'admin' ? (
            <section className="panel full-width">
              <div className="panel-header">
                <h2>Admin Panel</h2>
                <button className="primary" onClick={handleTriggerDraw} disabled={!isAdmin}>
                  Trigger draw
                </button>
              </div>
              <div className="admin-grid">
                <div>
                  <h3>Users</h3>
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
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h3>Recent draws</h3>
                  <div className="stack">
                    {state.draws.length ? (
                      state.draws.slice(0, 5).map((draw) => (
                        <div key={draw.id} className="score-row">
                          <strong>{draw.numbers.join(' • ')}</strong>
                          <span>{formatDate(draw.date)}</span>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No draws have been run yet.</p>
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
