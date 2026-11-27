(function () {
  const CFG = window.PORTAL_CONFIG || {};
  const SUPABASE_URL = (CFG.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const SUPABASE_ANON_KEY = (CFG.SUPABASE_ANON_KEY || "").trim();

  const SESSION_STORAGE_KEY = "sa_portal_saved_session";
  const THEME_STORAGE_KEY = "sa_portal_theme";

  const state = {
    studentId: "",
    pin: "",
    semesterId: null,
    activeMobileTab: "overview",
    portalData: null,
    cachedLogs: [],
    pendingStudent: null,
  };

  // ---------- Helpers ----------

  const $ = (id) => document.getElementById(id);

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatSyncTime(iso) {
    if (!iso) return "Not synced yet";
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(iso);
    }
  }

  function showToast(msg) {
    const box = $("toastBox");
    const txt = $("toastText");
    if (!box || !txt) return;
    txt.textContent = msg;
    box.classList.remove("hidden");
    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.classList.add("hidden"), 3500);
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  function showView(viewName) {
    const views = {
      login: $("loginView"),
      changePassword: $("changePasswordView"),
      forgot: $("forgotView"),
      dashboard: $("dashboardView"),
    };
    Object.entries(views).forEach(([key, el]) => {
      if (!el) return;
      el.classList.toggle("hidden", key !== viewName);
    });
    window.scrollTo({ top: 0 });
    refreshIcons();
  }

  // ---------- Theme Switcher ----------

  function applyTheme(theme) {
    const t = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute("content", t === "light" ? "#dce3ed" : "#0b1120");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {}

    document.querySelectorAll(".theme-icon-sun").forEach((el) => {
      el.classList.toggle("hidden", t === "light");
    });
    document.querySelectorAll(".theme-icon-moon").forEach((el) => {
      el.classList.toggle("hidden", t === "dark");
    });
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "dark" ? "light" : "dark");
  }

  // ---------- Supabase RPC & Edge Function Clients ----------

  async function callRpc(fnName, body = {}) {
    if (!SUPABASE_URL.startsWith("https://") || SUPABASE_URL.includes("তোমার-প্রজেক্ট")) {
      throw new Error("Portal config missing. Set SUPABASE_URL and SUPABASE_ANON_KEY in config.js.");
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.message || data?.hint || `Cloud request failed (${res.status})`);
    }
    return data;
  }

  async function callEdgeFunction(fnName, body = {}) {
    if (!SUPABASE_URL.startsWith("https://") || SUPABASE_URL.includes("তোমার-প্রজেক্ট")) {
      throw new Error("Portal config missing. Set SUPABASE_URL and SUPABASE_ANON_KEY in config.js.");
    }

    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        data?.error ||
          data?.message ||
          "Email recovery service is not active yet. Please contact your department or university office."
      );
    }
    return data;
  }

  // ---------- Password Strength & Live Checklist ----------

  function setRuleVisual(el, ok) {
    if (!el) return;
    el.className = `flex items-center gap-2 ${ok ? "text-emerald-400 font-semibold" : "text-dim"}`;
    const icon = el.querySelector("svg, i");
    if (icon) {
      const nextIcon = document.createElement("i");
      nextIcon.setAttribute("data-lucide", ok ? "check-circle-2" : "circle");
      nextIcon.className = "w-3.5 h-3.5 shrink-0";
      icon.replaceWith(nextIcon);
    }
  }

  function updatePasswordFormFeedback() {
    const pw = $("newPassInput")?.value || "";
    const cf = $("confirmPassInput")?.value || "";
    const curPin = state.pin || "";

    $("pwCharCount").textContent = `${pw.length} / 12`;

    const lenOk = pw.length >= 6 && pw.length <= 12;
    const diffOk = pw.length > 0 && pw !== curPin;
    const matchOk = pw.length > 0 && pw === cf;

    setRuleVisual($("ruleLen"), lenOk);
    setRuleVisual($("ruleDiff"), diffOk);
    setRuleVisual($("ruleMatch"), matchOk);
    refreshIcons();

    // Strength meter calculation (optional variety bonus)
    let score = 0;
    if (pw.length >= 6) score += 1;
    if (pw.length >= 8) score += 1;
    if (/[a-zA-Z]/.test(pw) && /\d/.test(pw)) score += 1;
    if (/[^a-zA-Z0-9]/.test(pw)) score += 1;

    const bar = $("pwStrengthBar");
    const lbl = $("pwStrengthLabel");

    if (!pw.length) {
      bar.style.width = "0%";
      bar.className = "h-full rounded-full transition-all duration-300";
      lbl.textContent = "Letters, numbers, or symbols allowed (any combination)";
      lbl.className = "text-[11px] text-dim font-medium";
    } else if (pw.length < 6) {
      bar.style.width = "22%";
      bar.className = "h-full rounded-full bg-rose-500 transition-all duration-300";
      lbl.textContent = "Too short — enter at least 6 characters";
      lbl.className = "text-[11px] text-rose-400 font-semibold";
    } else if (score <= 1) {
      bar.style.width = "45%";
      bar.className = "h-full rounded-full bg-amber-500 transition-all duration-300";
      lbl.textContent = "Valid password (Basic strength)";
      lbl.className = "text-[11px] text-amber-400 font-semibold";
    } else if (score === 2) {
      bar.style.width = "75%";
      bar.className = "h-full rounded-full bg-cyan-500 transition-all duration-300";
      lbl.textContent = "Good password strength";
      lbl.className = "text-[11px] text-cyan-400 font-semibold";
    } else {
      bar.style.width = "100%";
      bar.className = "h-full rounded-full bg-emerald-500 transition-all duration-300";
      lbl.textContent = "Strong password";
      lbl.className = "text-[11px] text-emerald-400 font-semibold";
    }

    $("changePassBtn").disabled = !(lenOk && diffOk && matchOk);
  }

  function openChangePasswordScreen(student) {
    state.pendingStudent = student;
    $("changeStudentInfo").innerHTML = `Welcome, <strong class="text-main">${esc(
      student.name
    )}</strong> (<span class="font-mono-code text-blue-400">${esc(
      student.student_id
    )}</span>). Create your personal password to continue.`;
    $("newPassInput").value = "";
    $("confirmPassInput").value = "";
    $("changePassError").classList.add("hidden");
    showView("changePassword");
    updatePasswordFormFeedback();
    setTimeout(() => $("newPassInput")?.focus(), 80);
  }

  // ---------- Smart Attendance Predictor ----------

  function computePrediction(course, collegiatePct) {
    const total = Number(course.total_classes || 0);
    const present = Number(course.present || 0);
    const late = Number(course.late || 0);
    const leave = Number(course.leave || 0);
    const penalty = Number(course.late_penalty_absents || 0);
    const pct = Number(course.percentage || 0);

    if (total <= 0) {
      return {
        tone: "neutral",
        icon: "clock",
        text: "Waiting for class logs",
      };
    }

    const effective = Math.max(0, present + late + leave - penalty);
    const R = Math.max(0.01, Math.min(1, Number(collegiatePct || 75) / 100));

    if (pct >= collegiatePct) {
      const canMiss = Math.floor(effective / R - total + 1e-9);
      if (canMiss > 0) {
        return {
          tone: "safe",
          icon: "shield-check",
          text: `Safe buffer: can miss up to ${canMiss} class${canMiss > 1 ? "es" : ""}`,
        };
      }
      return {
        tone: "warn",
        icon: "alert-circle",
        text: `On edge: attend next class to stay ≥ ${collegiatePct}%`,
      };
    }

    if (R >= 1) {
      return {
        tone: "danger",
        icon: "alert-triangle",
        text: "Requires 100% attendance target",
      };
    }

    const needed = Math.max(1, Math.ceil((R * total - effective) / (1 - R) - 1e-9));
    return {
      tone: "danger",
      icon: "trending-up",
      text: `Attend next ${needed} class${needed > 1 ? "es" : ""} straight to reach ${collegiatePct}%`,
    };
  }

  function getStatusMeta(pct, config) {
    if (pct === null || isNaN(pct)) {
      return {
        label: "No Classes Yet",
        short: "Pending",
        stroke: "#64748b",
        badge: "bg-slate-500/15 text-slate-400 border-slate-500/30",
        text: "text-sub",
      };
    }
    if (pct >= config.collegiate_threshold) {
      return {
        label: "Collegiate (Eligible)",
        short: "Collegiate",
        stroke: "#10b981",
        badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        text: "text-emerald-400",
      };
    }
    if (pct >= config.non_collegiate_threshold) {
      return {
        label: "Non-Collegiate (Warning)",
        short: "Non-Collegiate",
        stroke: "#f59e0b",
        badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        text: "text-amber-400",
      };
    }
    return {
      label: "Dis-Collegiate (Shortage)",
      short: "Dis-Collegiate",
      stroke: "#f43f5e",
      badge: "bg-rose-500/15 text-rose-400 border-rose-500/30",
      text: "text-rose-400",
    };
  }

  // ---------- Branding Loader ----------

  async function loadBranding() {
    try {
      const b = await callRpc("get_portal_branding", {});
      const dept = b.org_department ? ` • ${b.org_department}` : "";
      $("brandSubtitle").textContent = `${b.org_short_name || "Smart Attendance"}${dept}`;
      $("brandOrgFull").textContent = b.org_full_name || "Live Attendance & Eligibility Portal";
      $("loginSyncMeta").textContent = b.last_synced_at
        ? `Cloud Synced: ${formatSyncTime(b.last_synced_at)}`
        : "Cloud Portal Ready";
    } catch (err) {
      $("loginSyncMeta").textContent = err.message;
    }
  }

  // ---------- Mobile Tab Switcher ----------

  function setMobileTab(tab) {
    state.activeMobileTab = tab;
    const sections = {
      overview: $("secOverview"),
      courses: $("secCourses"),
      history: $("secHistory"),
    };

    Object.entries(sections).forEach(([key, el]) => {
      if (!el) return;
      el.classList.toggle("mobile-tab-hidden", key !== tab);
    });

    document.querySelectorAll("#mobileNav .mobile-nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });

    if (window.innerWidth < 768) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // ---------- Render Course Card HTML ----------

  function buildCourseCardHtml(course, config) {
    const pct = Number(course.percentage || 0);
    const meta = getStatusMeta(course.total_classes > 0 ? pct : null, config);
    const pred = computePrediction(course, config.collegiate_threshold);

    const radius = 23;
    const circ = 2 * Math.PI * radius;
    const offset = circ - (Math.min(100, Math.max(0, pct)) / 100) * circ;

    const predToneMap = {
      safe: "bg-emerald-500/10 border-emerald-500/25 text-emerald-400",
      warn: "bg-amber-500/10 border-amber-500/25 text-amber-400",
      danger: "bg-rose-500/10 border-rose-500/25 text-rose-400",
      neutral: "bg-slate-500/10 border-slate-500/20 text-sub",
    };

    return `
      <div class="glass-card glass-card-hover rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-4">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h5 class="text-base font-extrabold text-main font-mono-code tracking-tight">${esc(course.course_code)}</h5>
              <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${meta.badge}">
                ${esc(course.eligibility || meta.short)}
              </span>
            </div>
            <p class="text-xs text-sub mt-1">
              Total Classes Held: <span class="font-mono-code font-bold text-main">${course.total_classes}</span>
              ${course.late_penalty_absents > 0 ? ` • <span class="text-amber-400 font-semibold">Late Penalty: -${course.late_penalty_absents}</span>` : ""}
            </p>
          </div>

          <div class="relative w-14 h-14 shrink-0 flex items-center justify-center">
            <svg class="w-14 h-14" viewBox="0 0 56 56">
              <circle class="ring-track" cx="28" cy="28" r="${radius}" fill="none" stroke-width="4.5"></circle>
              <circle class="ring-progress" cx="28" cy="28" r="${radius}" fill="none" stroke="${meta.stroke}" stroke-width="4.5" stroke-linecap="round"
                stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
            </svg>
            <span class="absolute text-[11px] font-extrabold font-mono-code text-main">${pct.toFixed(0)}%</span>
          </div>
        </div>

        <div class="grid grid-cols-4 gap-2 text-center">
          <div class="bg-chip rounded-xl py-2 px-1">
            <p class="text-[10px] uppercase tracking-wider text-dim font-semibold">Present</p>
            <p class="text-sm font-extrabold font-mono-code text-emerald-400 mt-0.5">${course.present}</p>
          </div>
          <div class="bg-chip rounded-xl py-2 px-1">
            <p class="text-[10px] uppercase tracking-wider text-dim font-semibold">Late</p>
            <p class="text-sm font-extrabold font-mono-code text-amber-400 mt-0.5">${course.late}</p>
          </div>
          <div class="bg-chip rounded-xl py-2 px-1">
            <p class="text-[10px] uppercase tracking-wider text-dim font-semibold">Leave</p>
            <p class="text-sm font-extrabold font-mono-code text-cyan-400 mt-0.5">${course.leave}</p>
          </div>
          <div class="bg-chip rounded-xl py-2 px-1">
            <p class="text-[10px] uppercase tracking-wider text-dim font-semibold">Absent</p>
            <p class="text-sm font-extrabold font-mono-code text-rose-400 mt-0.5">${course.absent}</p>
          </div>
        </div>

        <div class="flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium ${predToneMap[pred.tone]}">
          <i data-lucide="${pred.icon}" class="w-3.5 h-3.5 shrink-0"></i>
          <span>${esc(pred.text)}</span>
        </div>
      </div>
    `;
  }

  // ---------- Render Attendance Logs ----------

  function renderLogs() {
    const courseVal = $("logCourseFilter").value || "ALL";
    const statusVal = $("logStatusFilter").value || "ALL";
    const query = ($("logSearchInput").value || "").trim().toLowerCase();

    const filtered = state.cachedLogs.filter((l) => {
      if (courseVal !== "ALL" && l.course_code !== courseVal) return false;
      if (statusVal !== "ALL" && l.status !== statusVal) return false;
      if (query) {
        const hay = `${l.date} ${l.course_code} ${l.room_name || ""}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    $("logsCountBadge").textContent = `${filtered.length} record${filtered.length === 1 ? "" : "s"}`;

    const badge = (st) => {
      if (st === "P") return `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">Present</span>`;
      if (st === "L") return `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">Late</span>`;
      if (st === "LV") return `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">Leave</span>`;
      return `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">${esc(st)}</span>`;
    };

    const tbody = $("logsTableBody");
    const mobileList = $("logsMobileList");

    if (!filtered.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="py-10 text-center text-dim text-xs">
            No attendance records match the current filter.
          </td>
        </tr>`;
      mobileList.innerHTML = `
        <div class="py-8 text-center text-dim text-xs">
          No attendance records match the current filter.
        </div>`;
      return;
    }

    tbody.innerHTML = filtered
      .map(
        (l) => `
        <tr class="hover:bg-blue-500/5 transition">
          <td class="py-3 px-4 font-mono-code text-main whitespace-nowrap">${esc(l.date)}</td>
          <td class="py-3 px-4 font-mono-code font-bold text-main whitespace-nowrap">${esc(l.course_code)}</td>
          <td class="py-3 px-4 text-sub whitespace-nowrap">${esc(l.room_name || "—")}</td>
          <td class="py-3 px-4 font-mono-code text-sub whitespace-nowrap">${esc(l.marked_time || "—")}</td>
          <td class="py-3 px-4 text-right whitespace-nowrap">${badge(l.status)}</td>
        </tr>`
      )
      .join("");

    mobileList.innerHTML = filtered
      .map(
        (l) => `
        <div class="bg-chip rounded-xl p-3 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-mono-code text-xs font-extrabold text-main">${esc(l.course_code)}</span>
              <span class="text-[11px] text-dim">•</span>
              <span class="font-mono-code text-[11px] text-sub">${esc(l.date)}</span>
            </div>
            <p class="text-[11px] text-dim mt-0.5 truncate">
              ${esc(l.room_name || "Classroom")} • ${esc(l.marked_time || "—")}
            </p>
          </div>
          <div class="shrink-0">${badge(l.status)}</div>
        </div>`
      )
      .join("");
  }

  // ---------- Render Full Dashboard ----------

  function renderDashboard(data) {
    state.portalData = data;
    const { student, config, semesters, courses, recent_logs } = data;
    state.cachedLogs = recent_logs || [];
    const courseList = courses || [];

    const dept = config.org_department ? ` • ${config.org_department}` : "";
    $("dashOrgLine").textContent = `${config.org_short_name || ""}${dept}`;
    $("dashBatchBadge").textContent = `Batch ${student.batch}`;
    $("dashStudentName").textContent = student.name;
    $("dashStudentId").textContent = student.student_id;
    $("dashSessionName").textContent = config.active_session_name || "Active Session";
    $("dashLastSynced").textContent = formatSyncTime(config.last_synced_at);

    const penText = config.late_penalty_count > 0 ? `${config.late_penalty_count} Late = 1 Absent` : "No Late Penalty";
    $("dashPolicyText").textContent =
      `Policy: ${penText} • Collegiate ≥ ${config.collegiate_threshold}% • Non-Collegiate ≥ ${config.non_collegiate_threshold}%`;

    $("printHeaderOrg").textContent = config.org_full_name || "Smart Attendance";
    $("printHeaderDept").textContent = `${config.org_short_name || ""}${dept} — Official Student Attendance Statement`;
    $("printHeaderDate").textContent = `Generated: ${new Date().toLocaleString()}`;

    const semSelect = $("semesterSelect");
    const curSem = state.semesterId === null ? "" : String(state.semesterId);
    semSelect.innerHTML =
      `<option value="">All Semesters</option>` +
      (semesters || [])
        .map(
          (s) =>
            `<option value="${s.id}">${esc(s.name)}${s.is_active ? " (Active)" : ""}</option>`
        )
        .join("");
    semSelect.value = curSem;

    let totClasses = 0,
      totPresent = 0,
      totLate = 0,
      totLeave = 0,
      totAbsent = 0,
      totPenalty = 0,
      eligibleCourses = 0;

    courseList.forEach((c) => {
      totClasses += Number(c.total_classes || 0);
      totPresent += Number(c.present || 0);
      totLate += Number(c.late || 0);
      totLeave += Number(c.leave || 0);
      totAbsent += Number(c.absent || 0);
      totPenalty += Number(c.late_penalty_absents || 0);
      if (Number(c.percentage || 0) >= config.collegiate_threshold) eligibleCourses++;
    });

    const effectiveAttended = Math.max(0, totPresent + totLate + totLeave - totPenalty);
    const overallPct = totClasses > 0 ? (effectiveAttended / totClasses) * 100 : null;
    const overallMeta = getStatusMeta(overallPct, config);

    const circ = 2 * Math.PI * 54;
    const ringEl = $("overallRingProgress");
    ringEl.style.stroke = overallMeta.stroke;
    ringEl.setAttribute("stroke-dasharray", circ.toFixed(2));
    const targetOffset =
      overallPct === null ? circ : circ - (Math.min(100, Math.max(0, overallPct)) / 100) * circ;
    requestAnimationFrame(() => {
      ringEl.setAttribute("stroke-dashoffset", targetOffset.toFixed(2));
    });

    $("overallRingPct").textContent = overallPct !== null ? `${overallPct.toFixed(1)}%` : "N/A";
    $("overallRingLabel").textContent = overallPct !== null ? `${effectiveAttended}/${totClasses} eff.` : "No logs";
    const badgeEl = $("overallBadge");
    badgeEl.textContent = overallMeta.label;
    badgeEl.className = `inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${overallMeta.badge}`;

    $("kpiPresent").textContent = totPresent + totLeave;
    $("kpiLeaveSub").textContent = `Approved Leave: ${totLeave}`;
    $("kpiLate").textContent = totLate;
    $("kpiPenaltySub").textContent = `Penalty Absents: ${totPenalty}`;
    $("kpiAbsent").textContent = totAbsent;
    $("kpiTotalSub").textContent = `Total Classes: ${totClasses}`;
    $("kpiCoursesCount").textContent = courseList.length;
    $("kpiEligibleSub").textContent =
      courseList.length > 0 ? `${eligibleCourses}/${courseList.length} Collegiate` : "No active courses";

    $("courseCountBadge").textContent = `${courseList.length} course${courseList.length === 1 ? "" : "s"}`;
    const coursesEl = $("coursesContainer");

    if (!courseList.length) {
      coursesEl.innerHTML = `
        <div class="md:col-span-2 xl:col-span-3 glass-card rounded-2xl p-10 text-center space-y-2">
          <div class="w-12 h-12 mx-auto rounded-2xl bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400">
            <i data-lucide="calendar-clock" class="w-6 h-6"></i>
          </div>
          <p class="text-sm font-bold text-main">No Attendance Synced Yet</p>
          <p class="text-xs text-sub max-w-md mx-auto">
            Once classes are recorded for Batch ${esc(student.batch)} and synced from the Smart Attendance desktop app, your course-wise progress and exam eligibility will appear here automatically.
          </p>
        </div>`;
    } else {
      coursesEl.innerHTML = courseList.map((c) => buildCourseCardHtml(c, config)).join("");
    }

    const previewEl = $("overviewCoursesPreview");
    const viewAllBtn = $("viewAllCoursesBtn");
    if (courseList.length > 0) {
      previewEl.innerHTML = courseList
        .slice(0, 2)
        .map((c) => {
          const pct = Number(c.percentage || 0);
          const meta = getStatusMeta(pct, config);
          return `
            <div class="bg-chip rounded-xl p-3 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="font-mono-code text-xs font-extrabold text-main">${esc(c.course_code)}</p>
                <p class="text-[11px] text-dim mt-0.5">P: ${c.present} • L: ${c.late} • A: ${c.absent}</p>
              </div>
              <div class="text-right shrink-0">
                <p class="font-mono-code text-sm font-extrabold ${meta.text}">${pct.toFixed(1)}%</p>
                <p class="text-[10px] text-dim">${esc(c.eligibility)}</p>
              </div>
            </div>`;
        })
        .join("");
      viewAllBtn.classList.remove("hidden");
    } else {
      previewEl.innerHTML = `<p class="text-xs text-dim text-center py-3">No courses recorded yet.</p>`;
      viewAllBtn.classList.add("hidden");
    }

    const uniqueCourses = [...new Set(state.cachedLogs.map((l) => l.course_code))].sort();
    $("logCourseFilter").innerHTML =
      `<option value="ALL">All Courses</option>` +
      uniqueCourses.map((cc) => `<option value="${esc(cc)}">${esc(cc)}</option>`).join("");
    $("logStatusFilter").value = "ALL";
    $("logSearchInput").value = "";
    renderLogs();

    showView("dashboard");
    setMobileTab(state.activeMobileTab);
  }

  async function fetchStudentPortal() {
    const data = await callRpc("get_student_portal_data", {
      p_student_id: state.studentId,
      p_pin: state.pin,
      p_semester_id: state.semesterId,
    });
    if (!data || !data.ok) {
      throw new Error(data?.error || "Invalid Student ID or Password.");
    }
    if (data.must_change_password) {
      openChangePasswordScreen(data.student);
      return { mustChange: true };
    }
    renderDashboard(data);
    return { mustChange: false };
  }

  // ---------- Event Binding ----------

  function wirePasswordToggle(inputId, btnId) {
    $(btnId)?.addEventListener("click", () => {
      const inp = $(inputId);
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      $(btnId).textContent = show ? "Hide" : "Show";
    });
  }

  function initEvents() {
    // Graceful Logo Fallback
    [
      ["brandLogoImg", "brandLogoFallback"],
      ["dashLogoImg", "dashLogoFallback"],
    ].forEach(([imgId, fbId]) => {
      const img = $(imgId);
      const fb = $(fbId);
      if (img && fb) {
        img.addEventListener("error", () => {
          img.classList.add("hidden");
          fb.classList.remove("hidden");
        });
      }
    });

    document.querySelectorAll(".theme-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", toggleTheme);
    });

    wirePasswordToggle("pinInput", "togglePinBtn");
    wirePasswordToggle("newPassInput", "toggleNewPassBtn");
    wirePasswordToggle("confirmPassInput", "toggleConfirmPassBtn");

    // Login Form Submit
    $("loginForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = $("loginError");
      const errTxt = $("loginErrorText");
      const btn = $("loginBtn");

      errBox.classList.add("hidden");
      btn.disabled = true;
      btn.innerHTML = `<span class="inline-flex items-center gap-2"><span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>Verifying Credentials...</span>`;

      state.studentId = $("studentIdInput").value.trim();
      state.pin = $("pinInput").value.trim();
      state.semesterId = null;

      try {
        const res = await fetchStudentPortal();
        if (!res.mustChange && $("rememberCheck")?.checked) {
          try {
            localStorage.setItem(
              SESSION_STORAGE_KEY,
              JSON.stringify({ studentId: state.studentId, pin: state.pin })
            );
          } catch {}
        }
      } catch (err) {
        errTxt.textContent = err.message;
        errBox.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.textContent = "Sign In to Attendance Portal";
      }
    });

    // Change Default Password Live Validation & Submit
    $("newPassInput")?.addEventListener("input", updatePasswordFormFeedback);
    $("confirmPassInput")?.addEventListener("input", updatePasswordFormFeedback);

    $("changePassForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = $("changePassError");
      const errTxt = $("changePassErrorText");
      const btn = $("changePassBtn");

      const newPass = ($("newPassInput").value || "").trim();
      const confirmPass = ($("confirmPassInput").value || "").trim();

      errBox.classList.add("hidden");

      if (newPass.length < 6 || newPass.length > 12) {
        errTxt.textContent = "Password must be between 6 and 12 characters.";
        errBox.classList.remove("hidden");
        return;
      }
      if (newPass === state.pin) {
        errTxt.textContent = "New password must be different from your default 6-digit PIN.";
        errBox.classList.remove("hidden");
        return;
      }
      if (newPass !== confirmPass) {
        errTxt.textContent = "Passwords do not match. Please re-enter carefully.";
        errBox.classList.remove("hidden");
        return;
      }

      btn.disabled = true;
      btn.innerHTML = `<span class="inline-flex items-center gap-2"><span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>Saving New Password...</span>`;

      try {
        const res = await callRpc("change_student_portal_password", {
          p_student_id: state.studentId,
          p_current_pin: state.pin,
          p_new_password: newPass,
        });
        if (!res || !res.ok) {
          throw new Error(res?.error || "Could not update password. Please try again.");
        }

        state.pin = newPass;
        if ($("rememberCheck")?.checked) {
          try {
            localStorage.setItem(
              SESSION_STORAGE_KEY,
              JSON.stringify({ studentId: state.studentId, pin: state.pin })
            );
          } catch {}
        }

        await fetchStudentPortal();
        showToast("New password saved! Welcome to your portal.");
      } catch (err) {
        errTxt.textContent = err.message;
        errBox.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.textContent = "Set New Password & Sign In";
      }
    });

    $("cancelChangePassBtn")?.addEventListener("click", () => {
      state.pin = "";
      $("pinInput").value = "";
      showView("login");
    });

    // Forgot Password View Navigation & Request
    $("openForgotBtn")?.addEventListener("click", () => {
      $("forgotError").classList.add("hidden");
      $("forgotSuccess").classList.add("hidden");
      const typedId = ($("studentIdInput")?.value || "").trim();
      if (typedId) $("forgotStudentIdInput").value = typedId;
      showView("forgot");
      setTimeout(() => $("forgotStudentIdInput")?.focus(), 80);
    });

    $("backToLoginBtn")?.addEventListener("click", () => {
      showView("login");
    });

    $("forgotForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = $("forgotError");
      const errTxt = $("forgotErrorText");
      const okBox = $("forgotSuccess");
      const okTxt = $("forgotSuccessText");
      const btn = $("forgotBtn");

      errBox.classList.add("hidden");
      okBox.classList.add("hidden");

      const sid = ($("forgotStudentIdInput").value || "").trim();
      if (!sid) {
        errTxt.textContent = "Please enter your Student ID.";
        errBox.classList.remove("hidden");
        return;
      }

      btn.disabled = true;
      btn.innerHTML = `<span class="inline-flex items-center gap-2"><span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>Sending Recovery Email...</span>`;

      try {
        const res = await callEdgeFunction("send-password-recovery", { student_id: sid });
        if (!res || !res.ok) {
          throw new Error(
            res?.error ||
              "Unable to send recovery email. Please contact your department or university office."
          );
        }
        okTxt.textContent =
          res.message ||
          "Your credentials have been emailed to your registered address. Please check your Inbox or Spam folder.";
        okBox.classList.remove("hidden");
      } catch (err) {
        errTxt.textContent = err.message;
        errBox.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.textContent = "Request Password";
      }
    });

    // Dashboard Controls
    $("semesterSelect")?.addEventListener("change", async (e) => {
      state.semesterId = e.target.value ? Number(e.target.value) : null;
      try {
        await fetchStudentPortal();
        showToast("Semester view updated");
      } catch (err) {
        showToast(err.message);
      }
    });

    $("refreshBtn")?.addEventListener("click", async () => {
      const btn = $("refreshBtn");
      btn.disabled = true;
      try {
        await fetchStudentPortal();
        showToast("Synced latest cloud records");
      } catch (err) {
        showToast(err.message);
      } finally {
        btn.disabled = false;
      }
    });

    $("printBtn")?.addEventListener("click", () => window.print());

    $("logoutBtn")?.addEventListener("click", () => {
      state.studentId = "";
      state.pin = "";
      state.semesterId = null;
      state.portalData = null;
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {}
      $("pinInput").value = "";
      showView("login");
    });

    $("logCourseFilter")?.addEventListener("change", renderLogs);
    $("logStatusFilter")?.addEventListener("change", renderLogs);
    $("logSearchInput")?.addEventListener("input", renderLogs);

    $("viewAllCoursesBtn")?.addEventListener("click", () => setMobileTab("courses"));

    document.querySelectorAll("#mobileNav .mobile-nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => setMobileTab(btn.dataset.tab));
    });
  }

  // ---------- Boot ----------

  async function boot() {
    const savedTheme = (() => {
      try {
        return localStorage.getItem(THEME_STORAGE_KEY) || "dark";
      } catch {
        return "dark";
      }
    })();
    applyTheme(savedTheme);
    initEvents();
    refreshIcons();
    loadBranding();

    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.studentId && saved?.pin) {
          state.studentId = saved.studentId;
          state.pin = saved.pin;
          $("studentIdInput").value = saved.studentId;
          await fetchStudentPortal().catch(() => {
            localStorage.removeItem(SESSION_STORAGE_KEY);
          });
        }
      }
    } catch {}
  }

  document.addEventListener("DOMContentLoaded", boot);
})();