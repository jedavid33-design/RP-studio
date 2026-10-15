(function directorFeature() {
  "use strict";
  const $d = id => document.getElementById(id);
  let tab = "discuss";
  let busy = false;
  function data() {
    state.director = normalizeDirector(state.director);
    return state.director;
  }
  function status(message = "", error = false) {
    const el = $d("directorStatus");
    el.textContent = message;
    el.classList.toggle("error", error);
  }
  function setTab(next) {
    tab = next === "direct" ? "direct" : "discuss";
    $d("directorDiscussPane").hidden = tab !== "discuss";
    $d("directorDirectPane").hidden = tab !== "direct";
    for (const [name, id] of [["discuss", "directorDiscussTab"], ["direct", "directorDirectTab"]]) {
      const btn = $d(id);
      btn.classList.toggle("active", name === tab);
      btn.setAttribute("aria-selected", String(name === tab));
    }
  }
  function renderDirector() {
    const d = data();
    const transcript = $d("directorConversation");
    transcript.replaceChildren();
    if (!d.messages.length) {
      const empty = document.createElement("div");
      empty.className = "director-empty";
      empty.textContent = "Your private writers' room. Ask about plot, pacing, or where to go next.";
      transcript.appendChild(empty);
    } else {
      d.messages.forEach(m => {
        const bubble = document.createElement("div");
        bubble.className = "director-note " + m.role;
        const label = document.createElement("span");
        label.className = "director-note-label";
        label.textContent = m.role === "user" ? "You · OOC" : "AI · Director";
        const body = document.createElement("span");
        body.textContent = m.content;
        bubble.append(label, body);
        transcript.appendChild(bubble);
      });
    }
    $d("directorInput").value = d.draft;
    $d("directorDirection").value = d.direction;
    const last = $d("directorLastApplied");
    last.hidden = !d.lastApplied;
    last.textContent = d.lastApplied ? "Last applied scene direction:\n" + d.lastApplied : "";
    transcript.scrollTop = transcript.scrollHeight;
    const hasDiscussion = d.messages.some(m => m.role === "user");
    for (const id of ["directorSendBtn", "directorExtractBtn", "directorSaveBtn", "directorStartBtn", "directorDiscussTab", "directorDirectTab", "directorCloseBtn"]) {
      $d(id).disabled = busy;
    }
    $d("directorExtractBtn").disabled = busy || !hasDiscussion;
    $d("directorStartBtn").disabled = busy || !d.direction.trim();
  }
  function lock(next) {
    busy = next;
    setTurnInFlight(next);
    renderDirector();
  }
  function close() {
    if (busy) return;
    data().draft = $d("directorInput").value.slice(0, 4000);
    data().direction = $d("directorDirection").value.slice(0, 4000);
    save();
    $d("directorDialog").close();
    status();
  }
  function open() {
    if (turnInFlight || busy) return;
    setTab("discuss");
    status();
    renderDirector();
    $d("directorDialog").showModal();
  }
  function canonReference() {
    const last = state.messages.filter(m => m.role === "user" || m.role === "assistant").slice(-14);
    return [
      "STORY SETUP, REFERENCE ONLY (not a new event):",
      "Title: " + state.scenario.title,
      "Player character: " + state.scenario.playerName,
      "Player facts, private unless explicitly revealed: " + state.scenario.playerNotes,
      "NPCs: " + state.scenario.npcNotes,
      "Premise: " + state.scenario.premise,
      "Boundaries: " + state.scenario.boundaryNotes,
      "Continuity established so far: " + (state.memory.summary || "No compressed memory yet."),
      "Latest CANON transcript, reference only:",
      last.map(m => (m.role === "user" ? "Player" : "NPC") + ": " + m.content.slice(0, 1100)).join("\n\n")
    ].join("\n\n").slice(0, 14500);
  }
  function directorMessages(additionalMessage) {
    const discussion = data().messages.slice(-24).map(m => ({ role: m.role, content: m.content }));
    if (additionalMessage) discussion.push({ role: "user", content: additionalMessage });
    return [
      { role: "system", content:
        "You are the OUT-OF-CHARACTER co-director for an interactive-fiction story. Converse as a collaborative writer, not a storyteller. Brainstorm and discuss alternative plot directions, pacing, character motivations, scene locations and time jumps. Ask useful questions, suggest 1-3 plausible directions, respect the user's preferences. NEVER write an in-character scene or character dialogue as the next story turn. Do not declare any discussed possibility canonical or assume a plan has been accepted. Clearly distinguish confirmed canon from ideas. Player character actions, thoughts, dialogue, emotions and decisions are ALWAYS reserved to the human player. NPCs do not know private player details unless established in canon. The discussion is isolated from story transcript and continuity memory.\n\n" + canonReference() },
      ...discussion
    ];
  }
  async function discuss() {
    if (turnInFlight || busy) return;
    const message = $d("directorInput").value.trim();
    if (!message) return status("Write something to discuss first.", true);
    data().draft = message;
    lock(true);
    status("Discussing with the selected model…");
    try {
      const answer = String(await requestAI(directorMessages(message), { maxTokens: 850 })).trim();
      if (!answer) throw new Error("The model returned an empty response.");
      const d = data();
      d.messages.push({ role: "user", content: message }, { role: "assistant", content: answer });
      d.messages = d.messages.slice(-100);
      d.draft = "";
      save();
      status("OOC only. Nothing has changed in the story.");
    } catch (e) {
      status("Discussion wasn't saved: " + (e?.message || String(e)) + ". Your draft is still here.", true);
    } finally { lock(false); }
  }
  async function extractPlan() {
    if (turnInFlight || busy) return;
    const d = data();
    if (!d.messages.some(m => m.role === "user")) return;
    lock(true);
    status("Preparing an editable plan from the discussion…");
    try {
      const raw = String(await requestAI([
        { role: "system", content:
          "You are a meticulous scene-planning assistant. Extract only directions the USER explicitly agreed to or requested in the following OOC discussion. Disregard possibilities the AI merely floated. Never infer actions, feelings, decisions, dialogue, or consent for the player character. Respect NPC knowledge limits. Output only a concise, usable next-scene directive in plain text (up to 280 words). If no direction was actually agreed, output exactly: NO_CONFIRMED_PLAN. Do not write story prose." },
        { role: "user", content: "CANON CONTEXT:\n" + canonReference() + "\n\nOOC DISCUSSION:\n" + data().messages.slice(-30).map(m => (m.role === "user" ? "User" : "Director") + ": " + m.content).join("\n\n") }
      ], { temperature: 0.2, maxTokens: 500 })).trim();
      if (!raw || /NO_CONFIRMED_PLAN/i.test(raw)) {
        status("No agreed scene direction found yet. Discuss more, or type one under Direct Scene.");
      } else {
        const suggested = raw.slice(0, 4000);
        if (data().direction.trim() && !confirm("Replace your existing saved scene plan with this draft?")) {
          status("Kept your existing plan.");
        } else {
          data().direction = suggested;
          save();
          setTab("direct");
          status("Drafted from your discussion. Review or edit it before starting.");
        }
      }
    } catch(e) { status("Couldn't draft the plan: " + (e?.message || String(e)), true); }
    finally { lock(false); }
  }
  function savePlan() {
    if (turnInFlight || busy) return;
    data().direction = $d("directorDirection").value.trim().slice(0, 4000);
    save();
    renderDirector();
    status(data().direction ? "Scene direction saved. Story canon is unchanged." : "Plan cleared. Story canon is unchanged.");
  }
  function sceneMessages(plan) {
    const recent = state.messages.slice(Math.min(state.memory.through, state.messages.length))
      .filter(m => m.role === "user" || m.role === "assistant");
    const sys = systemPrompt() + "\n\nDIRECTOR-APPROVED SCENE TRANSITION (OVERRIDES ONLY NORMAL IMMEDIATE-TURN TIMING):\n" +
      "The final user message in this request is OUT-OF-CHARACTER direction, never dialogue or an action by " + state.scenario.playerName + ". " +
      "You MAY jump to the specifically requested future time/place, but must not invent an action, arrival, location change, thought, feeling, or decision for the player character. " +
      "Open with a vivid objective setting beat or NPC action/dialogue from the new scene. Do not reenact prior events. NPC knowledge constraints and all player-agency rules remain absolute. " +
      "Do not explain the transition, show OOC text, or narrate the player. Advance a single meaningful NPC beat and hand control back.";
    const messages = [{ role: "system", content: sys }];
    if (state.memory.summary) messages.push({ role: "system", content: "ESTABLISHED CANON REFERENCE ONLY:\n" + state.memory.summary });
    if (recent[0]?.role === "assistant") messages.push({ role: "user", content: "PREVIOUS CANON SETUP ONLY: The next assistant message is a completed scene. Never replay it." });
    recent.forEach(m => messages.push({ role: m.role, content: m.content }));
    messages.push({ role: "user", content: "OUT-OF-CHARACTER DIRECTOR INSTRUCTION, NOT A PLAYER TURN:\n" + plan + "\n\nWrite ONLY the new NPC/environment scene opening. Do not choose or describe anything the player character does." });
    return messages;
  }
  async function startScene() {
    if (turnInFlight || busy) return;
    const plan = $d("directorDirection").value.trim().slice(0, 4000);
    if (!plan) return status("Add a scene direction before starting.", true);
    data().direction = plan;
    save();
    lock(true);
    status("Opening the directed scene…");
    try {
      const reply = cleanStoryReply(await requestAI(sceneMessages(plan)));
      if (!reply || isNaturalHandoff(reply)) throw new Error("The AI didn't produce a scene opening. Your plan is saved for retry.");
      const violation = findAgencyViolation(reply);
      if (violation) throw new Error("Hands Off blocked a player-character takeover (" + violation.type + "). Nothing entered canon; edit the plan or try again.");
      const before = state.messages.length;
      const accepted = acceptOrBlock(reply);
      if (!accepted || state.messages.length !== before + 1 || state.messages.at(-1)?.role !== "assistant") {
        throw new Error("No story scene was accepted. Your plan is retained.");
      }
      const d = data();
      d.lastApplied = plan;
      d.direction = "";
      save();
      renderDirector();
      status("Scene started. The agreed opening is now canon.");
      $d("directorDialog").close();
    } catch (e) {
      status("Scene not started: " + (e?.message || String(e)), true);
    } finally { lock(false); }
  }
  $d("directorOpenBtn").onclick = open;
  $d("directorCloseBtn").onclick = close;
  $d("directorDiscussTab").onclick = () => { if (!busy) setTab("discuss"); };
  $d("directorDirectTab").onclick = () => { if (!busy) setTab("direct"); };
  $d("directorSendBtn").onclick = discuss;
  $d("directorExtractBtn").onclick = extractPlan;
  $d("directorSaveBtn").onclick = savePlan;
  $d("directorStartBtn").onclick = startScene;
  $d("directorDialog").addEventListener("cancel", e => { if (busy) e.preventDefault(); });
  $d("directorDialog").addEventListener("close", () => {
    if (busy) return;
    const d = data();
    d.draft = $d("directorInput").value.slice(0, 4000);
    if (tab === "direct") d.direction = $d("directorDirection").value.slice(0, 4000);
    save();
  });
  $d("directorInput").addEventListener("change", () => { if (!busy) { data().draft = $d("directorInput").value.slice(0, 4000); save(); } });
  $d("directorDirection").addEventListener("input", () => {
    if (busy) return;
    const typed = $d("directorDirection").value.slice(0, 4000);
    data().direction = typed;
    $d("directorStartBtn").disabled = !typed.trim();
  });
  $d("directorDirection").addEventListener("change", () => { if (!busy) { data().direction = $d("directorDirection").value.slice(0, 4000); save(); renderDirector(); } });
  $d("directorInput").addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); discuss(); }
  });
})();
