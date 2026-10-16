/* RP Studio Shared Universe v1.3.0
 * Universes live inside the existing encrypted story library.
 * Approved, timeline-valid canon is injected as REFERENCE, never prose.
 * All proposed changes require explicit user approval.
 */
(function sharedUniverseFeature() {
  "use strict";
  const el = id => document.getElementById(id);
  const uid = () => "pm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  const today = () => new Date().toISOString();
  const str = v => String(v == null ? "" : v);
  const trim = (value, limit = 2000) => str(value).trim().slice(0, limit);
  const escapeText = (text, max = 600) => trim(text, max).replace(/\s+/g, " ");
  const universeList = () => storyLibrary.universes || (storyLibrary.universes = {});
  const currentUniverse = () => universeList()[state.universeId || ""] || null;
  const selectedUniverse = () => universeList()[el("universeSelect")?.value || ""] || null;
  let generating = false;

  function newUniverse(name, description = "") {
    const id = uid();
    return { id, name: trim(name, 90), description: trim(description, 1500), createdAt: today(),
      updatedAt: today(), revision: 1, facts: [] };
  }
  function newFact(universe, entry) {
    return { id: uid(), subject: trim(entry.subject, 100), text: trim(entry.text, 1400),
      kind: ["person", "place", "organization", "event", "relationship", "other"].includes(entry.kind) ? entry.kind : "event",
      visibility: entry.visibility === "private" ? "private" : "public",
      knownBy: Array.isArray(entry.knownBy) ? entry.knownBy.map(x => trim(x, 90)).filter(Boolean).slice(0, 30) : [],
      effectiveAt: /^\d{4}-\d{2}-\d{2}$/.test(entry.effectiveAt || "") ? entry.effectiveAt : "",
      status: entry.status === "approved" ? "approved" : "proposed",
      sourceStoryId: entry.sourceStoryId || null, sourceMessageIndex: Number.isInteger(entry.sourceMessageIndex) ? entry.sourceMessageIndex : null,
      createdAt: today(), updatedAt: today() };
  }
  function touch(universe) { universe.updatedAt = today(); universe.revision = Number(universe.revision || 0) + 1; save(); render(); }
  function knowsInStory(fact) {
    if (fact.visibility === "public") return true;
    const npc = str(state.scenario.npcNotes).toLowerCase();
    return (fact.knownBy || []).some(name => name.length > 2 && npc.includes(name.toLowerCase()));
  }
  function applicableFacts(universe) {
    const date = state.inWorldDate || "";
    return (universe.facts || []).filter(fact => fact.status === "approved" &&
      (!fact.effectiveAt || (date && fact.effectiveAt <= date)) && knowsInStory(fact));
  }
  // This is consumed by the normal RP prompt and by Director Mode, never
  // saved as a fictional in-character message or copied into another transcript.
  window.rpUniversePrompt = () => {
    const universe = currentUniverse();
    if (!universe) return "";
    const applicable = applicableFacts(universe).slice(-110);
    const factLines = applicable.map(f => {
      const provenance = f.sourceStoryId ? "Story " + f.sourceStoryId : "Universe foundation";
      const visibility = f.visibility === "private" ?
        "PRIVATE; KNOWN ONLY TO: " + (f.knownBy || []).join(", ") + "; NEVER give this knowledge to other NPCs" : "PUBLIC";
      return "- [" + f.kind.toUpperCase() + "; " + visibility + "; " + (f.effectiveAt || "undated") +
        "; " + provenance + "] " + f.subject + ": " + f.text;
    });
    return [
      "SHARED WORLD: " + escapeText(universe.name, 100),
      "WORLD CANON REFERENCE, NOT AN EVENT TO PLAY OUT:",
      "Use only approved facts valid at the active story date. These facts already happened or are standing background.",
      "NEVER expose private knowledge to anyone except people explicitly named as knowing it.",
      "NEVER infer that another character heard, saw, or discovered a private fact. Planned outcomes are NOT canon.",
      "Do not invent offscreen facts about another storyline or determine anything for any player-controlled protagonist.",
      "Active story date: " + (state.inWorldDate || "not set; future dated events withheld"),
      ...(factLines.length ? factLines : ["No approved applicable shared canon yet."])
    ].join("\n").slice(0, 14500);
  };

  function ensureList() {
    const select = el("universeSelect");
    if (!select) return;
    const chosen = select.value || state.universeId || "";
    select.replaceChildren();
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = "Choose a universe…";
    select.appendChild(blank);
    Object.values(universeList()).sort((a,b)=>a.name.localeCompare(b.name)).forEach(u => {
      const o = document.createElement("option");
      o.value = u.id; o.textContent = u.name;
      select.appendChild(o);
    });
    select.value = universeList()[chosen] ? chosen : (state.universeId || "");
    if (!universeList()[select.value]) select.value = "";
  }
  function textNode(parent, tag, content, className = "") {
    const node = document.createElement(tag);
    node.textContent = content;
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
  }
  function action(parent, label, fn, className = "secondary") {
    const btn = textNode(parent, "button", label, className);
    btn.type = "button"; btn.onclick = fn; return btn;
  }
  function displayFacts() {
    const u = selectedUniverse(), host = el("universeFactList");
    if (!host) return;
    host.replaceChildren();
    if (!u) { textNode(host, "p", "Select or create a universe to view its canon."); return; }
    const facts = [...(u.facts || [])].sort((a,b)=>str(b.createdAt).localeCompare(str(a.createdAt)));
    if (!facts.length) { textNode(host, "p", "No canon records yet."); return; }
    facts.forEach(f => {
      const row = document.createElement("div"); row.className = "universe-fact";
      textNode(row, "strong", f.subject + (f.effectiveAt ? " · " + f.effectiveAt : ""), "");
      const descr = f.text + (f.visibility === "private" ? "\n🔒 Known by: " + ((f.knownBy || []).join(", ") || "nobody recorded") : "");
      textNode(row, "div", descr, "universe-fact-body");
      textNode(row, "small", f.kind + " · " + f.visibility + " · " + f.status +
        (f.sourceStoryId ? " · from linked story" : " · universe reference"), "universe-meta");
      if (f.status === "proposed") {
        action(row, "✓ Approve canon", () => {
          if (!confirm("Approve this as shared canon for all connected stories, subject to date and privacy?")) return;
          f.status = "approved"; f.updatedAt = today(); touch(u); renderPanel();
        }, "primary");
      }
      if (f.status === "approved") action(row, "Mark for review", () => {
        if (!confirm("Withdraw this fact from shared prompts? Existing written scenes are never changed automatically.")) return;
        f.status = "review"; f.updatedAt = today(); touch(u); renderPanel();
      });
      if (f.status === "review") action(row, "Reapprove", () => {
        if (!confirm("Make this shared fact active again?")) return;
        f.status = "approved"; f.updatedAt = today(); touch(u); renderPanel();
      });
      action(row, "Delete", () => {
        if (!confirm("Delete this canon record permanently? This will not alter existing story transcripts.")) return;
        u.facts = u.facts.filter(other => other.id !== f.id); touch(u); renderPanel();
      }, "text-btn");
      host.appendChild(row);
    });
  }
  function renderPanel() {
    ensureList();
    const u = selectedUniverse();
    const connected = currentUniverse();
    const stat = el("universeCurrentLink");
    if (stat) stat.textContent = "Current story: " + (state.scenario.title || "Untitled Story") +
      " · " + (connected ? "Linked to " + connected.name : "Independent") +
      (state.inWorldDate ? " · In-world " + state.inWorldDate : " · Set an in-world date for timeline filtering");
    el("universeDate").value = state.inWorldDate || "";
    const buttons = ["universeLinkBtn", "universeProposeBtn", "universeSuggestBtn"];
    for (const id of buttons) el(id).disabled = !u || generating;
    el("universeLinkBtn").textContent = !u ? "Link current story" :
      (state.universeId === u.id ? "Unlink current story" : "Link current story");
    el("universeFactCount").textContent = u ?
      u.facts.filter(f=>f.status==="approved").length + " approved · " +
      u.facts.filter(f=>f.status==="proposed").length + " awaiting approval · " +
      u.facts.filter(f=>f.status==="review").length + " review needed" : "";
    displayFacts();
  }
  function open() {
    if (typeof turnInFlight !== "undefined" && turnInFlight) return;
    renderPanel();
    el("universeDialog").showModal();
  }
  function propose(fields) {
    const u = selectedUniverse();
    if (!u) return false;
    if (!fields.text || !fields.subject) { alert("Enter a subject and a fact or event."); return false; }
    u.facts.push(newFact(u, fields));
    touch(u); renderPanel();
    return true;
  }
  function createPortMeridian() {
    if (Object.values(universeList()).some(u => u.name.toLowerCase() === "port meridian")) {
      alert("Port Meridian already exists. Select it from the universe list.");
      return;
    }
    const u = newUniverse("Port Meridian", "Multi-sport American city connected by Northline Sports Group.");
    const entries = [
      ["organization","Port Meridian Breakers","NHL franchise based in Port Meridian; navy and teal team colors."],
      ["organization","Port Meridian Pilots","Port Meridian's MLB franchise. Its story is not yet underway."],
      ["organization","Port Meridian Royals","Professional basketball franchise in Port Meridian."],
      ["organization","Port Meridian FC","Professional soccer franchise in Port Meridian."],
      ["organization","Northline Sports Group","Prominent multisport sports agency headquartered in Port Meridian."],
      ["person","Leo Bennett","22-year-old Breakers rookie left wing, #27, from Duluth, Minnesota; second-round draft pick; two AHL seasons. Cheerful, sociable, fiercely competitive."],
      ["person","Nathan “Nate” Sullivan","32-year-old Breakers captain, center #19, in his fifth season as captain. Confident, charismatic, warm, habit-loving. Has seriously dated women."],
      ["person","Sloane Mercer","34-year-old senior Northline agent who has represented Leo since his prospect years. Sharp, loyal and professionally ambitious."],
      ["person","Connor Bell","34-year-old Breakers defenseman and alternate captain; Nate's longtime close friend, married to Nadia, father of a young daughter."],
      ["person","Mateo Alvarez","29-year-old Breakers right wing and outgoing team social organizer."],
      ["person","Julian Park","28-year-old Breakers goalie; dry humor; fosters rescue dogs."],
      ["person","Rory Gallagher","23-year-old second-year Breakers right wing and a potential friend for Leo."],
      ["person","Amir Rahman","27-year-old Breakers defenseman active in community outreach."],
      ["person","Helena Ward","48-year-old Breakers head coach; tactically demanding and fair."],
      ["person","Tess Walker","36-year-old Breakers head athletic trainer."],
      ["person","Paige Sullivan","Nate's 29-year-old sister, based in Buffalo, working in wildlife rehabilitation."],
      ["person","Robin Vale","Owner of Harborline Coffee and longtime friend of Nate."],
      ["person","Claire Rowan","Urban planner and former long-term romantic partner of Nate; their separation was amicable."],
      ["place","Harborline Coffee","Nate's regular morning coffee shop in Port Meridian."]
    ];
    entries.forEach(([kind,subject,text]) => u.facts.push(newFact(u,{kind,subject,text,status:"approved"})));
    u.facts.push(newFact(u,{kind:"person",subject:"Leo Bennett · private sexuality",
      text:"Leo is gay and out to his parents, sister Mara, agent Sloane Mercer, and select longtime friends; he is not publicly out and his teammates do not automatically know.",
      visibility:"private",knownBy:["Sloane Mercer","Mara Bennett"],status:"approved"}));
    universeList()[u.id] = u;
    save();
    ensureList();
    el("universeSelect").value = u.id;
    renderPanel();
    el("universeStatus").textContent = "Port Meridian foundation created. Planned future romance arcs are deliberately not approved canon.";
  }

  // Called before rewind's atomic library write. Shared facts from erased
  // portions are quarantined; the user must explicitly approve again.
  window.rpUniverseOnRewind = (candidate, storyId, keptCount) => {
    let withdrawn = 0;
    for (const u of Object.values(candidate.universes || {})) {
      let changed = false;
      for (const f of u.facts || []) {
        if (f.sourceStoryId === storyId && Number.isInteger(f.sourceMessageIndex) &&
            f.sourceMessageIndex >= keptCount && ["approved", "proposed"].includes(f.status)) {
          f.status = "review"; f.updatedAt = today(); withdrawn++; changed = true;
        }
      }
      if (changed) { u.updatedAt = today(); u.revision = (u.revision || 0) + 1; }
    }
    return withdrawn;
  };

  async function suggestFromStory() {
    if (generating || turnInFlight) return;
    const u = selectedUniverse();
    if (!u || state.universeId !== u.id) {
      el("universeStatus").textContent = "Link the active story to this universe before extracting its canon.";
      return;
    }
    const recent = state.messages.filter(m=>m.role==="user"||m.role==="assistant").slice(-8);
    if (!recent.length) { el("universeStatus").textContent = "No story scenes to examine yet."; return; }
    generating = true; renderPanel();
    el("universeStatus").textContent = "Analyzing recent completed story turns · 1 model request…";
    try {
      const raw = str(await requestAI([
        {role:"system",content:"Extract at most ONE significant, confirmed shared-universe fact from completed interactive-fiction turns. Treat player-authored events as authoritative but DO NOT add any new player actions or decisions. Do not suggest future plans, unspoken feelings, conclusions about sexuality, or events that have not occurred. Never disclose private player facts as public. Reply ONLY with a JSON object: {\"subject\":\"...\",\"text\":\"...\",\"kind\":\"event\",\"visibility\":\"public or private\",\"knownBy\":[\"names if private\"]}. If nothing relevant has happened, respond exactly NO_SHARED_CANON. No code fences."},
        {role:"user",content:"UNIVERSE: "+u.name+"\nSTORY: "+state.scenario.title+"\nSTORY DATE: "+(state.inWorldDate||"unknown")+"\nRECENT COMPLETED STORY:\n"+recent.map(m=>(m.role==="user"?"PLAYER":"NPC")+": "+m.content.slice(0,1200)).join("\n\n")}
      ],{temperature:0.1,maxTokens:420})).trim();
      if (!raw || raw.includes("NO_SHARED_CANON")) {
        el("universeStatus").textContent = "No verified shared change found. Nothing was published.";
      } else {
        let entry;
        try { entry = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/gi,"")); }
        catch { throw new Error("The model did not return a usable canon proposal."); }
        const validKinds = ["person","place","organization","event","relationship","other"];
        if (!entry || typeof entry !== "object" || !trim(entry.subject) || !trim(entry.text) ||
            !validKinds.includes(entry.kind) || !["public","private"].includes(entry.visibility) ||
            (entry.visibility === "private" && (!Array.isArray(entry.knownBy)||!entry.knownBy.length))) {
          throw new Error("Proposal lacked required details. No canon was added.");
        }
        const f = newFact(u,{...entry,effectiveAt:state.inWorldDate||"",status:"proposed",
          sourceStoryId:storyLibrary.activeId,sourceMessageIndex:state.messages.length-1});
        u.facts.push(f); touch(u); renderPanel();
        el("universeStatus").textContent = "Proposal saved. Review and approve it before other stories can use it.";
      }
    } catch(err){el("universeStatus").textContent = "No canon published: "+err.message;}
    finally {generating=false;renderPanel();}
  }

  function initialize() {
    if (!el("universeDialog") || !el("universeOpenBtn")) return;
    el("universeOpenBtn").onclick = open;
    el("universeCloseBtn").onclick = () => el("universeDialog").close();
    el("universeSelect").onchange = renderPanel;
    el("universeCreateBtn").onclick = () => {
      const name = trim(el("universeName").value,90);
      if (!name) return alert("Enter a universe name.");
      if (Object.values(universeList()).some(u=>u.name.toLowerCase()===name.toLowerCase()))
        return alert("That universe already exists.");
      const u = newUniverse(name);
      universeList()[u.id] = u;
      save();
      el("universeName").value = "";
      ensureList();
      el("universeSelect").value = u.id;
      renderPanel();
    };
    el("universeStarterBtn").onclick = createPortMeridian;
    el("universeLinkBtn").onclick = () => {
      const u = selectedUniverse(); if (!u) return;
      state.universeId = state.universeId === u.id ? "" : u.id;
      save(); renderPanel(); if (el("libraryDialog").open) renderLibrary();
    };
    el("universeDate").onchange = () => {
      state.inWorldDate = el("universeDate").value || "";
      save(); renderPanel();
    };
    el("universeProposeBtn").onclick = () => {
      const ok = propose({
        subject:el("universeSubject").value, text:el("universeFactText").value,
        kind:el("universeKind").value, effectiveAt:el("universeFactDate").value || "",
        visibility:el("universeVisibility").value,
        knownBy:el("universeKnownBy").value.split(",").map(x=>x.trim()).filter(Boolean),
        sourceStoryId: state.universeId === selectedUniverse()?.id ? storyLibrary.activeId : null,
        sourceMessageIndex: state.universeId === selectedUniverse()?.id ? state.messages.length-1 : null
      });
      if (ok) { el("universeSubject").value="";el("universeFactText").value="";el("universeKnownBy").value="";
        el("universeStatus").textContent = "Proposed. Nothing becomes shared canon until approved."; }
    };
    el("universeSuggestBtn").onclick = suggestFromStory;
    el("universeVisibility").onchange = () => {
      el("universeKnownByWrap").hidden = el("universeVisibility").value !== "private";
    };
    el("universeKnownByWrap").hidden = true;
    window.rpUniverseRender = renderPanel;
    renderPanel();
  }
  initialize();
})();
