# Neuroscience Alignment Survey for `akm improve`

> **Status (2026-07-05, meta-review 14):** the neuroscience framing is **inspiration, not justification** — this survey is the grading source for that ruling (e.g. it grades recombine's confirmation gate "Loose, no biological analogue"). Do not cite brain analogies as design justification.

**Purpose.** `akm improve` is a self-learning memory-curation pipeline for AI-agent knowledge that explicitly models several of its mechanisms on brain function: encoding salience, an outcome/feedback loop, retrieval-strength decay, homeostatic demotion, consolidation, REM-like recombination, procedural compilation, proactive maintenance, and contradiction detection/belief revision. This document is a citation-rigorous survey of the actual neuroscience behind each of those analogies, written for a technical review panel judging how faithful — and where deliberately or accidentally divergent — the engineering is relative to biology.

**Method.** Three research passes were run independently, each using web search and page fetches to verify every citation (author, year, venue, and a source URL) rather than relying on model memory. Citations that could not be independently confirmed are explicitly marked **UNVERIFIED** or **PLAUSIBLE (not independently re-verified)** in place, rather than presented as settled fact. Section numbering follows the ten neuroscience areas requested; a cross-cutting synthesis table follows Section 10.

---

## Section 1: Complementary Learning Systems (CLS)

**(a) Established findings**

The Complementary Learning Systems framework argues mammalian memory is served by two systems with deliberately mismatched learning rates. The hippocampus is a fast, sparse, pattern-separating learner: high learning rates and orthogonalized representations rapidly bind the co-occurring elements of a single episode without interfering with prior knowledge. The neocortex is a slow, densely-overlapping learner: low learning rates and distributed representations gradually extract statistical structure — regularities, categories, schemas — across many episodes. The 1995 paper's central computational argument, from feedforward connectionist simulations, is that a single fast-learning system with overlapping representations is intrinsically unstable: forcing rapid learning into a network that shares weights with old knowledge produces *catastrophic interference*. The proposed solution: the hippocampus learns a new episode quickly in isolation, then *replays* it interleaved with samples of old, already-consolidated material during offline periods, so the neocortex integrates the new item gradually without disrupting existing structure — training-data replay as a biological mechanism, decades before it was rediscovered as the standard fix for catastrophic forgetting in deep networks (elastic weight consolidation, generative replay, experience replay in RL).

The 2016 Kumaran, Hassabis & McClelland update reframes CLS for deep-RL systems (explicitly citing DQN's experience-replay buffer as a CLS-inspired design). It recasts the hippocampal system as supplying complementary **rapid, one-shot generalization from few examples** (episodic control), useful when statistics are too sparse for slow learning to have extracted structure yet, and argues the fast/slow, sparse/distributed dual-rate principle can recur at multiple scales within an agent, not just at the hippocampus/cortex boundary — interleaved replay is the general mechanism.

**(b) Key citations**

- McClelland, J. L., McNaughton, B. L., & O'Reilly, R. C. (1995). "Why there are complementary learning systems in the hippocampus and neocortex: Insights from the successes and failures of connectionist models of learning and memory." *Psychological Review*, 102(3), 419–457. https://www.researchgate.net/publication/15575602 · https://www.semanticscholar.org/paper/2ebf18e7892e660a833152ddc6cf8f1d21a7b881
- Kumaran, D., Hassabis, D., & McClelland, J. L. (2016). "What Learning Systems do Intelligent Agents Need? Complementary Learning Systems Theory Updated." *Trends in Cognitive Sciences*, 20(7), 512–534. https://www.cell.com/trends/cognitive-sciences/abstract/S1364-6613(16)30043-2 · https://stanford.edu/~jlmcc/papers/KumaranHassabisMcClelland16FinalMS.pdf

**(c) Computational principle for an engineered system**

Do not let a single store both (i) absorb novel, low-sample-count information instantly and (ii) hold the system's stable, generalized knowledge. Separate fast-write/high-specificity storage from slow-write/generalized storage, and connect them only via an explicit, rate-controlled, *interleaved* transfer process — never by writing new items directly and permanently into the generalized store at full strength.

**(d) Alignment with akm**

akm's closest analogue pairs (i) raw memory ingestion (fast, per-episode, salience-triggered writes into the stash) with (ii) **recombination** (clustering + distilling generalized lessons) and **consolidation** (merging near-duplicates). Structurally this is a CLS pattern: episodic-like writes accumulate, and a slower process periodically extracts cross-episode structure. Recombination's "multi-run hypothesis confirmation before promotion" is a stricter analogue of CLS's gradual, interleaved neocortical integration — it prevents a single episode from directly overwriting general knowledge.

Divergences: (1) CLS's core mechanism is prevention of *catastrophic interference* via representational separation (pattern separation in DG/CA3 vs. overlapping cortical codes); akm has no representational split — raw memories and distilled lessons typically share the same embedding geometry, so there is no architectural guarantee against a bad distilled lesson interfering with unrelated good knowledge. (2) CLS interleaving specifically replays *old* items alongside new ones to *protect old knowledge*; akm's recombination clusters "related" memories to generalize, which is a thematic interleave, not a stability-preserving one — though because akm's substrate is retrieval-augmented text rather than fixed network weights, it doesn't actually suffer catastrophic interference in the neural sense, so this divergence is largely benign. (3) CLS's episodic system also does one-shot rapid generalization (episodic control) for sparse data; akm's raw stash has no such built-in few-shot generalization distinct from recombination.

---

## Section 2: Systems Consolidation & Replay

**(a) Established findings**

During quiet wakefulness and slow-wave sleep, the hippocampus produces sharp-wave ripples (SWRs) — brief (~100 ms), high-frequency (~150–250 Hz) events during which previously active place-cell ensembles reactivate in the order they fired during behavior, compressed ~10–20×. Wilson & McNaughton (1994) gave the founding demonstration: cell pairs co-active while a rat traversed a location fired together at elevated rates during subsequent sleep. Carr, Jadhav & Frank's 2011 review shows replay is not sleep-exclusive — it also occurs in brief awake SWRs at pauses in behavior, and can depict unexecuted future/hypothetical trajectories, implicating replay in online planning, not just offline storage transfer. Girardeau, Benchenane, Wiener, Zugaro & Buzsáki (2009) gave causal evidence: selective real-time disruption of SWRs during post-training rest impaired subsequent spatial memory without affecting task performance or sleep architecture otherwise — ripples are necessary, not epiphenomenal. Mattar & Daw (2018) gave the normative capstone: replay content is well predicted by an item's "gain" (how much a value update there would improve future decisions) times its "need" (likelihood of being visited soon) — the brain replays whichever memories are most *useful* to revisit next, not merely strongest or most recent.

**(b) Key citations**

- Wilson, M. A., & McNaughton, B. L. (1994). "Reactivation of hippocampal ensemble memories during sleep." *Science*, 265(5172), 676–679. https://www.science.org/doi/10.1126/science.8036517 · https://pubmed.ncbi.nlm.nih.gov/8036517/
- Carr, M. F., Jadhav, S. P., & Frank, L. M. (2011). "Hippocampal replay in the awake state: a potential substrate for memory consolidation and retrieval." *Nature Neuroscience*, 14(2), 147–153. https://www.nature.com/articles/nn.2732
- Girardeau, G., Benchenane, K., Wiener, S. I., Zugaro, M. B., & Buzsáki, G. (2009). "Selective suppression of hippocampal ripples impairs spatial memory." *Nature Neuroscience*, 12(10), 1222–1223. https://www.nature.com/articles/nn.2384 · http://zugarolab.net/wp-content/uploads/Girardeau2009.pdf. (The commonly-cited "Girardeau & Zugaro" review is the companion Girardeau & Zugaro 2011, "Hippocampal ripples and memory consolidation," *Current Opinion in Neurobiology*, 21(3), 452–459 — https://www.sciencedirect.com/science/article/abs/pii/S0959438811000316 — a review; the 2009 paper is cited as the load-bearing causal-evidence study.)
- Mattar, M. G., & Daw, N. D. (2018). "Prioritized memory access explains planning and hippocampal replay." *Nature Neuroscience*, 21(11), 1609–1617. https://www.nature.com/articles/s41593-018-0232-z · code: https://github.com/marcelomattar/PrioritizedReplay

**(c) Computational principle for an engineered system**

(1) Consolidation should be driven by selective, compressed replay of recent high-value experience during dedicated offline (low-load) periods, not uniform or continuous processing of all stored items. (2) Within that replay budget, prioritize by expected decision-utility (gain × need), not recency or raw frequency alone.

**(d) Alignment with akm**

Maps onto akm's **proactive maintenance** (periodic, offline-style review of stale assets) and, more precisely, onto whatever selection policy governs which memories get reviewed/consolidated/recombined in a batch pass. Mattar & Daw's gain × need formulation is a strong normative correction if akm's proactive-maintenance/recombine selection leans on recency or staleness alone rather than expected future utility. The causal ripple-disruption work supports the *existence* of a dedicated offline consolidation phase (akm's batch improve/recombine/proactive-maintenance runs) and warns that skipping or interrupting that phase (e.g., profiles with `sync.enabled=false`, or runs interrupted before their end-of-run commit batch) should be expected to degrade consolidation quality, not just delay it.

Divergences: (1) biological replay is *sequential, compressed reactivation of temporally ordered ensembles* — it replays trajectories, not discrete items; akm's recombination clusters semantically related memories ("what goes together"), with no analogue to sequence-structured or reverse-vs-forward replay direction. (2) Awake replay's role in *online planning* (simulating hypothetical futures during behavior) has no akm analogue — akm's replay-like mechanisms are exclusively retrospective/offline. (3) Mattar & Daw's prioritization signal is reward-prediction-derived value recomputed within a formal MDP; akm's salience signals are computed at encoding time and, per this brief, are not clearly recomputed fresh at selection/replay time — risking replay/review ordered by a stale utility estimate rather than a currently relevant one.

---

## Section 3: Synaptic Tagging & Capture + Dopaminergic/Novelty Modulation of Encoding

**(a) Established findings**

Frey & Morris (1997) established **synaptic tagging and capture (STC)**: strong tetanic stimulation induces protein-synthesis-dependent "late-LTP" at the stimulated synapses, while weak stimulation elsewhere induces only transient "early-LTP." If weak stimulation at an independent synaptic population occurs within roughly a ±1–2 hour window of strong stimulation elsewhere in the same neuron/network, the weak pathway's potentiation is also converted to a persistent form. Mechanism: strong stimulation sets a transient, synapse-specific "tag" and triggers synthesis of plasticity-related proteins (PRPs) that diffuse and are captured by *any* recently tagged synapse — a spillover consolidation mechanism.

Moncada & Viola (2007) showed the behavioral-level analogue, **behavioral tagging**: weak inhibitory-avoidance training that alone produces only short-term memory is converted to long-term memory if the animal is exposed to a novel environment within about an hour before or after training; blocking protein synthesis at the time of novelty exposure abolishes the rescue.

Lisman & Grace (2005) proposed the **hippocampal–VTA loop**: the hippocampus computes a novelty/mismatch signal (does new input match anything already stored?), relayed polysynaptically to increase burst firing of VTA dopamine neurons; the resulting dopamine facilitates the transition from early- to late-LTP, effectively licensing the plasticity proteins STC requires. Related human fMRI work (Bunzeck & Düzel 2006; Wittmann et al. 2007) corroborates joint SN/VTA-hippocampal activation to novelty predicting subsequent memory success.

**(b) Key citations**

- Frey, U., & Morris, R. G. M. (1997). "Synaptic tagging and long-term potentiation." *Nature*, 385(6616), 533–536. https://www.nature.com/articles/385533a0
- Moncada, D., & Viola, H. (2007). "Induction of long-term memory by exposure to novelty requires protein synthesis: evidence for a behavioral tagging." *Journal of Neuroscience*, 27(28), 7476–7481. https://www.jneurosci.org/content/27/28/7476 · https://pubmed.ncbi.nlm.nih.gov/17626208/
- Lisman, J. E., & Grace, A. A. (2005). "The hippocampal-VTA loop: controlling the entry of information into long-term memory." *Neuron*, 46(5), 703–713. https://www.cell.com/neuron/fulltext/S0896-6273(05)00397-1
- Bunzeck, N., & Düzel, E. (2006). "Absolute Coding of Stimulus Novelty in the Human Substantia Nigra/VTA." *Neuron*, 51(3), 369–379. https://www.cell.com/neuron/fulltext/S0896-6273(06)00475-2
- Wittmann, B. C., et al. (2007). "Reward-Related fMRI Activation of Dopaminergic Midbrain Is Associated with Enhanced Hippocampus-Dependent Long-Term Memory Formation." *Neuron*, 45(3), 459–467.
- **UNVERIFIED**: a single canonical "Düzel et al. 2010" paper matching the exact human hippocampal-VTA-loop imaging claim could not be pinned down with confidence; the closest well-attested 2010 Düzel citation is the NOMAD review (Düzel, Bunzeck, Guitart-Masip, & Düzel, 2010, *Neuroscience & Biobehavioral Reviews*, 34(5), 660–669), offered as the best-supported match rather than a guaranteed exact one. The general claim itself is independently supported by the Bunzeck & Düzel 2006 and Wittmann et al. 2007 papers above.

**(c) Computational principle for an engineered system**

(1) Salience should gate long-term storage, not just weight it — STC implies a roughly threshold/gating process, and temporal proximity to a salient event can rescue an otherwise-forgettable item, not just the item's own salience. (2) Novelty/prediction-error should be computed by comparing new input against *existing stored knowledge* (a comparator/mismatch signal), not treated as a context-free stimulus property. (3) The consolidation-triggering signal is a shared, diffusible, time-windowed resource — nearby-in-time weak items can piggyback on a strong item's consolidation budget.

**(d) Alignment with akm**

This is the most directly relevant section to akm's **encoding salience** (novelty × magnitude × prediction-error). akm's multiplicative formula is a reasonable computational gloss on the hippocampal-VTA loop: hippocampal novelty/mismatch detection modulating VTA dopamine release, which licenses durable storage. Note that "novelty" (Lisman & Grace) and "reward prediction error" (Section 4, Schultz) are related but *distinct* dopaminergic functions in the literature — akm's formula folding both into one composite score is a known simplification worth flagging explicitly, not a settled equivalence.

Divergences: (1) STC's most distinctive prediction — a low-salience item can be *rescued* into long-term storage by temporal proximity to a separate high-salience event — has no clear akm analogue; akm's salience score is computed per-memory from its own novelty/magnitude/prediction-error, with no time-windowed salience boost from neighboring highly salient events. This is a concrete, testable design gap. (2) STC/behavioral tagging is fundamentally about rescuing a trace via a *later-arriving* consolidation resource; akm's salience score is computed at encoding time and, per this brief, is not retroactively revisited when a later related high-salience event occurs. (3) The hippocampal-VTA loop's novelty computation compares against existing *long-term* stored knowledge broadly; if akm's "novelty" term is computed cheaply against only a recent window rather than the full consolidated stash, it is a narrower notion of novelty than the biological comparator.

---

## Section 4: Reward Prediction Error and Dopamine

**(a) Established findings**

Midbrain dopamine neurons (VTA, SNc) do not fire in proportion to reward magnitude; single-unit recordings in behaving monkeys show they encode a *reward prediction error* (RPE) — firing above baseline when reward is better than expected, near baseline when fully predicted, depressed below baseline when reward is worse than expected or omitted. Once a cue reliably predicts reward, the phasic dopamine response migrates from reward delivery to the predictive cue — a hallmark of a temporal-difference-style error signal. Schultz, Dayan & Montague (1997) formalized this by mapping midbrain dopamine activity onto the TD-error term δ from reinforcement learning. Schultz's subsequent reviews (e.g. 2016) show the RPE signal scales with formal economic utility, generalizes across species, and appears more weakly in striatum, amygdala, and frontal cortex — the core computation is prediction-error-shaped value updating, not raw reward magnitude.

**(b) Key citations**

- Schultz, W., Dayan, P., & Montague, P. R. (1997). "A Neural Substrate of Prediction and Reward." *Science*, 275(5306), 1593–1599. https://doi.org/10.1126/science.275.5306.1593 · https://www.gatsby.ucl.ac.uk/~dayan/papers/sdm97.pdf
- Schultz, W. (2016). "Dopamine reward prediction error coding." *Dialogues in Clinical Neuroscience*, 18(1), 23–32. https://doi.org/10.31887/DCNS.2016.18.1/wschultz. (Distinct from Watabe-Uchida, Eshel & Uchida 2017, *Annual Review of Neuroscience*, "Neural Circuitry of Reward Prediction Error" — a related but separately-authored circuit-level review; do not conflate the two.)
- Sutton, R. S., & Barto, A. G. (2018, 2nd ed.). *Reinforcement Learning: An Introduction*. MIT Press — standard TD-learning reference; Sutton (1988), "Learning to Predict by the Methods of Temporal Differences," *Machine Learning*, 3(1), 9–44, is the original TD formalization.
- **PLAUSIBLE (not independently re-verified beyond search corroboration)**: Montague, Dayan, & Sejnowski (1996). "A Framework for Mesencephalic Dopamine Systems Based on Predictive Hebbian Learning." *Journal of Neuroscience*, 16(5), 1936–1947 — the paper most associated with formally linking TD error to dopamine; flagged here as the connective citation but not independently fetched against the primary source in this pass.

**(c) Computational principle for an engineered system**

The biological signal is error between predicted and realized outcome, propagated backward toward the earliest reliable predictor (temporal credit assignment), driving V(s) ← V(s) + α·δ where δ = r + γV(s′) − V(s). Engineering takeaways: (1) update magnitude should scale with *surprise*, not raw feedback polarity — a confirmed expectation should produce a near-zero update; (2) credit should migrate to an early, reliable predictor once one is learned, not stay pinned to final outcomes only; (3) the same error signal driving value updates is a natural salience signal at encoding time.

**(d) Alignment with akm**

Maps directly onto akm's **outcome/feedback loop** (prediction-error-shaped value updates from usage feedback) and **encoding salience**. The match is genuinely close — akm's dual use of prediction-error for both salience weighting and value updates mirrors dopamine's dual role in surprise-driven learning-rate and attentional/consolidation priority.

Divergences: (i) biological RPE is computed via *temporal-difference bootstrapping* across a state sequence with credit propagating backward through a learned value function; akm's feedback loop, as described, is closer to a single-step episodic outcome update than a full TD chain with credit migrating to earlier reliable predictors. (ii) Dopamine RPE is bidirectional (negative for worse-than-expected outcomes, including active suppression below baseline for omitted expected reward) — an engineered system should confirm its feedback loop symmetrically penalizes disconfirmed expectations, not just reward positive surprises. (iii) Dopamine RPE is myopic to reward magnitude alone, saying nothing about *what* was learned; akm additionally folds prediction-error into a composite salience score with novelty and magnitude, which is an engineering synthesis with no single clean neural mechanism behind it, and should be presented as such.

---

## Section 5: Forgetting and Retrieval-Strength / Storage-Strength Theory

**(a) Established findings**

Ebbinghaus (1885) produced the first quantitative forgetting curve from self-experimentation with nonsense syllables: retention drops steeply then decelerates, an approximately negative-exponential/power-law shape. Murre & Dros (2015, *PLOS ONE*) directly replicated this shape using Ebbinghaus's own methodology.

Bjork & Bjork's (1992) "New Theory of Disuse" reframes forgetting as the interaction of two dissociable quantities: **storage strength** (how well-integrated an item is — cumulative, effectively non-decreasing, unconscious) and **retrieval strength** (how currently accessible an item is — volatile, capacity-limited, strongly modulated by recency and practice). A high-storage-strength item can have low retrieval strength (feels "forgotten" but relearns fast); retrieval strength is a saturating, competitive resource, and successful retrieval increases storage strength *more* when retrieval strength was low at the time of retrieval (the "desirable difficulty" principle).

Cepeda, Pashler, Vul, Wixted & Rohrer (2006), a large-scale meta-analysis (839 effect sizes, 317 experiments), confirmed the spacing effect: distributed practice reliably outperforms massed practice, and — critically — the optimal inter-study interval scales with the desired retention interval; the longer you want something remembered, the longer the optimal gap between reinforcing exposures should be.

**(b) Key citations**

- Ebbinghaus, H. (1885/1913 trans.). *Memory: A Contribution to Experimental Psychology*. Teachers College, Columbia University — canonical original source.
- Murre, J. M. J., & Dros, J. (2015). "Replication and Analysis of Ebbinghaus' Forgetting Curve." *PLOS ONE*, 10(7), e0120644. https://doi.org/10.1371/journal.pone.0120644. (The widely-repeated "67% forgotten within 24 hours" figure is a common paraphrase, not independently pinned to a verified primary-source table — treat that exact percentage as **UNVERIFIED**/approximate; the qualitative curve shape is solid.)
- Bjork, R. A., & Bjork, E. L. (1992). "A New Theory of Disuse and an Old Theory of Stimulus Fluctuation." In A. F. Healy, S. M. Kosslyn, & R. M. Shiffrin (Eds.), *From Learning Processes to Cognitive Processes* (Vol. 2, pp. 35–67). Erlbaum. https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2016/07/RBjork_EBjork_1992.pdf
- Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). "Distributed Practice in Verbal Recall Tasks: A Review and Quantitative Synthesis." *Psychological Bulletin*, 132(3), 354–380. https://doi.org/10.1037/0033-2909.132.3.354 · https://pubmed.ncbi.nlm.nih.gov/16719566/

**(c) Computational principle for an engineered system**

Track two separate variables per memory item: a slowly-accumulating, monotonic *storage strength*, and a fast, decaying, recency-and-competition-sensitive *retrieval strength* used for ranking/surfacing. Decay retrieval strength from time-since-last-successful-use, not time-since-creation. Increase storage strength preferentially when a retrieval succeeds *after* retrieval strength had dropped low. Reinforcement schedules should widen as an item accumulates confirmed long-term value, per the spacing effect's retention-interval-dependent optimum.

**(d) Alignment with akm**

Maps onto akm's **retrieval-strength decay with recency**. This is a good surface match (the mechanism borrows Bjork & Bjork's own terminology) but the alignment is partial: (i) Bjork & Bjork's theory is explicitly *two-strength*; if akm implements a single decaying score per memory (conflating "how reinforced" with "how recently used"), it has collapsed the theory's central distinguishing claim — a rarely-retrieved but foundational, storage-strong lesson should decay in retrieval *priority* without being demoted in underlying importance, and this needs to be verified against akm's actual schema rather than assumed from the label. (ii) The spacing-effect literature implies decay/reinforcement schedules should be adaptive to desired retention horizon; a single flat recency half-life for all memory types diverges from Cepeda et al.'s core finding. (iii) Ebbinghaus's curve concerns raw episodic recall of arbitrary nonsense-syllable content; applying it to curated, semantically-linked "lessons" is an extrapolation beyond the original experimental domain and should be flagged as analogy, not direct empirical transfer.

---

## Section 6: Synaptic Homeostasis Hypothesis (SHY) and Sleep-Dependent Synaptic Downscaling

**(a) Established findings**

Tononi & Cirelli's Synaptic Homeostasis Hypothesis (SHY) proposes wakefulness is dominated by net synaptic potentiation as an unavoidable byproduct of plasticity, carrying costs (energy/space demand, capacity saturation, degraded signal-to-noise as weak/spurious synapses accumulate alongside important ones). Sleep — specifically NREM slow-wave activity — renormalizes (downscales) synaptic strength roughly *proportionally*, restoring learning capacity while preserving relative strength differences: strongest/most-recently-reinforced connections survive downscaling while weak, unreinforced, noise-driven synapses are pruned toward baseline. The 2014 Neuron review extends this with cellular mechanism and connects downscaling to consolidation/integration benefits (better signal-to-noise, generalization/schema extraction).

**(b) Key citations**

- Tononi, G., & Cirelli, C. (2003). "Sleep and Synaptic Homeostasis: A Hypothesis." *Brain Research Bulletin*, 62(2), 143–150. https://doi.org/10.1016/j.brainresbull.2003.09.004
- Tononi, G., & Cirelli, C. (2014). "Sleep and the Price of Plasticity: From Synaptic and Cellular Homeostasis to Memory Consolidation and Integration." *Neuron*, 81(1), 12–34. https://doi.org/10.1016/j.neuron.2013.12.025 · https://pmc.ncbi.nlm.nih.gov/articles/PMC3921176/
- Contextual: Tononi & Cirelli (2006), "Sleep function and synaptic homeostasis," *Sleep Medicine Reviews*, 10(1), 49–62, https://pubmed.ncbi.nlm.nih.gov/16376591/ (mid-point evolution of the theory); and for balance, Frank, M. G. (2012), "Why I Am Not SHY: A Reply to Tononi and Cirelli," PMC3583075, which raises evidence against uniform/proportional downscaling in some circuits — SHY is not uncontested and should not be presented as unanimously settled.

**(c) Computational principle for an engineered system**

(i) Downscaling should be periodic/batch, not continuous per-event — decoupling write throughput from global pruning. (ii) It should be proportional/multiplicative, scaling down by a factor related to current strength, rather than a flat subtractive penalty, so strong items resist a downscaling pass far more than weak ones. (iii) It should be capacity-motivated (triggered on schedule or storage-pressure), not purely age-motivated.

**(d) Alignment with akm**

Direct analogue for akm's **homeostatic demotion** (periodic downscaling of stale, unreviewed memories) and, secondarily, informs **proactive maintenance**. Both are periodic, batch, offline-style processes motivated by capacity/signal-to-noise restoration rather than individual-item merit — a genuinely strong structural match.

Divergences: (i) SHY's downscaling is explicitly proportional, preserving relative differences and being gentler on strong synapses; if akm's homeostatic demotion applies a flat, uniform decay/threshold regardless of underlying strength, it is closer to naive decay than to SHY — multiplicative downscaling weighted by current salience/storage-strength would be the more faithful implementation. (ii) SHY operates on *all* synapses potentiated during wake, not only "unreviewed" ones; akm's gating on review status is a reasonable engineering proxy but not something drawn directly from the neuroscience — the biological trigger is elapsed potentiation broadly. (iii) SHY is fundamentally about restoring systemic capacity for future learning; akm's "stale, unreviewed" framing is closer to relevance/quality curation, a related but distinct objective — conflating them risks demoting low-traffic-but-still-valid items rather than items genuinely crowding out capacity. (iv) The 2014 review's link from downscaling to consolidation/integration/generalization is arguably the more precise mechanistic anchor for akm's **recombination ("REM-like")** mechanism than for demotion — worth cross-referencing so recombination isn't grounded only loosely in "REM" by name (see Section 8).

---

## Section 7: Memory Integration, Schema-Consistent Consolidation, Pattern Completion/Separation

**(a) Established findings**

Systems-level consolidation is not fixed-duration. Tse et al. (2007) showed that once an associative "schema" has been built up over many trials in a hippocampal-dependent paired-associate task, a *single new schema-congruent trial* can be consolidated into a schema-independent, rapidly stabilized cortical representation — collapsing a normally weeks-long process into essentially one exposure. This only works for schema-*congruent* information; schema-incongruent information integrates far more slowly and initially remains hippocampus-dependent. Disrupting the associated cortical circuit blocked the rapid-consolidation effect, establishing schemas as causally, not just correlationally, involved.

Preston & Eichenbaum (2013) integrate this into a circuit account: the hippocampus rapidly binds item-specific detail into pattern-separated traces (DG/CA3 pattern separation, CA3/CA1 pattern completion), while prefrontal cortex represents higher-order generalized structure that biases both encoding and retrieval. New information congruent with an existing schema is *assimilated* (an update/merge on the abstract representation); information that conflicts with or is orthogonal to the schema is kept as a separate, pattern-separated trace (*differentiation*).

**(b) Key citations**

- Tse, D., Langston, R. F., Kakeyama, M., Bethus, I., Spooner, P. A., Wood, E. R., Witter, M. P., & Morris, R. G. M. (2007). "Schemas and Memory Consolidation." *Science*, 316(5821), 76–82. https://doi.org/10.1126/science.1135935
- Preston, A. R., & Eichenbaum, H. (2013). "Interplay of Hippocampus and Prefrontal Cortex in Memory." *Current Biology*, 23(17), R764–R773. https://pmc.ncbi.nlm.nih.gov/articles/PMC3789138/ · https://www.sciencedirect.com/science/article/pii/S0960982213006362
- Supporting: Bakker, A., Kirwan, C. B., Miller, M., & Stark, C. E. L. (2008). "Pattern Separation in the Human Hippocampal CA3 and Dentate Gyrus." *Science*, 319(5870), 1640–1642. https://doi.org/10.1126/science.1152882

**(c) Computational principle for an engineered system**

Two distinct integration operations, gated by a congruence test against existing abstract structure — not a single uniform "merge if similar" rule: (1) **Assimilation** — items highly congruent with an existing schema/cluster get a cheap, near-immediate merge update rather than sitting as an independent trace awaiting batch processing. (2) **Differentiation** — items conflicting with or weakly related to existing structure stay as distinct, non-merged traces; premature merging of dissimilar items destroys distinguishing detail.

**(d) Alignment with akm**

akm's **consolidation** pass (merging near-duplicate memories) is a reasonable engineering analogue of assimilation.

Divergences: the biology's core finding is not "duplicates get merged," it is "items congruent with a *pre-existing higher-order structure* get merged fast; everything else stays separate." If akm's consolidation only operates on near-duplicate *pairs* by surface/embedding similarity rather than merging into an evolving abstract schema/cluster, it is missing the schema-mediation step Preston & Eichenbaum identify as doing the actual work — and risks the *opposite* failure mode from the biology: over-merging items similar in embedding space but functionally incongruent (Tse's rats show incongruent information does *not* get the fast-consolidation benefit). A closer biological analogue to true schema-mediated merging is arguably akm's **recombination** pass (which clusters and generalizes) rather than the dedup-style consolidation pass — if these are two unrelated pipelines rather than one congruence-gated assimilate-vs-differentiate decision, that is a structural divergence worth flagging. Additionally, pattern separation is an *active* decorrelation mechanism, not merely "declining to merge" — an engineered analogue should verify its "keep separate" default doesn't itself cause retrieval interference among correctly-unmerged near-duplicates.

---

## Section 8: REM Sleep, Abstraction, and Creative Generalization

**(a) Established findings**

Stickgold & Walker (2013) frame sleep-dependent memory processing as *selective triage*: sleep preferentially consolidates memories tagged as emotionally salient, rewarded, or otherwise flagged important at encoding, while weakly tagged material weakens or is forgotten. The outcome is not verbatim strengthening but *generalization* — extraction of statistical regularities/gist across related episodes.

Lewis, Knoblich & Poe (2018) propose a dual-process account of sleep and creative problem-solving: non-REM replay (hippocampal SWRs coupled to neocortical slow oscillations and spindles) is associated with abstraction of rules/structure from related memories; REM sleep, under weaker/noisier aminergic-cholinergic neuromodulation, is associated with more permissive, remote associative replay, allowing atypical connections between otherwise-unrelated memories. Their proposal: alternating NREM/REM cycles interleave schema-building (NREM) with novel/remote-link sampling (REM), producing analogical insight over a night, or across multiple nights for harder problems.

**On "multi-run hypothesis confirmation before promotion" specifically**: neither source describes anything like a discrete, gated confirmation step before a generalized abstraction is "promoted." The mechanisms are continuous, graded, and probabilistic — abstraction emerges gradually via repeated replay across many sleep cycles, not a single all-or-nothing checkpoint. Weak/spurious REM associations are not curated by an upfront verification pass; they are filtered downstream by relative reactivation frequency, subsequent waking reinforcement/extinction, and (per the separate SHY literature in Section 6) synaptic downscaling of weakly-potentiated connections. There is no evidence of a discrete multi-trial statistical confirmation gate; generalization strength is graded and accumulates stochastically, closer to a continuously-updated weight than a pass/fail decision.

**(b) Key citations**

- Stickgold, R., & Walker, M. P. (2013). "Sleep-dependent memory triage: evolving generalization through selective processing." *Nature Neuroscience*, 16(2), 139–145. https://doi.org/10.1038/nn.3303 · https://pmc.ncbi.nlm.nih.gov/articles/PMC5826623/
- Lewis, P. A., Knoblich, G., & Poe, G. (2018). "How Memory Replay in Sleep Boosts Creative Problem-Solving." *Trends in Cognitive Sciences*, 22(6), 491–503. https://doi.org/10.1016/j.tics.2018.03.009 · https://orca.cardiff.ac.uk/id/eprint/111453/1/Lewis.%20How%20memory%20replay.pdf

**(c) Computational principle for an engineered system**

Generalization/abstraction should be a graded, repeatedly-reinforced accumulation process — a confidence score updating incrementally each time supporting instances are re-encountered, converging asymptotically — not a single-shot or small-N discrete confirmation event. Two generalization modes should be kept distinct: (i) a conservative, structure-preserving abstraction over closely related items (non-REM-like), the main source of "safe" generalized lessons; and (ii) a higher-variance, exploratory recombination over weaker/remote associations (REM-like), whose outputs should be treated as lower-confidence proposals needing more downstream evidence, filtered by accept-and-monitor over time rather than upfront gating.

**(d) Alignment with akm — the single most important nuance in this survey**

akm's **recombination ("REM-like")** mechanism is aligned in its coarse framing: clustering related memories and generalizing to abstract lessons is a legitimate analogue of sleep-dependent abstraction, and prioritizing salient material for processing echoes Stickgold & Walker's selective triage (though that connection more properly belongs to akm's encoding-salience mechanism).

**Divergence to flag explicitly to the review panel: "multi-run hypothesis confirmation before promotion" has no biological analogue and should not be presented as neuroscience-grounded.** The literature describes graded, probabilistic, continuously-reinforced generalization across many replay events, not a discrete N-run statistical confirmation gate. akm's discrete gate is a defensible **engineering safety mechanism** — it guards against promoting spurious one-off correlations into permanent belief — but it is an addition that goes *beyond*, and in character partially *contradicts*, the biological mechanism, which lets weak associations persist at low strength and lets usage/downstream reinforcement (or synaptic downscaling) organically decide their fate rather than gating on confirmation upfront. A closer biological analogue would be a continuously-updated confidence score with no hard promotion threshold — closer to a running Bayesian update than a pass/fail gate. Additionally, the dual-mode NREM/REM distinction (safe structure-preserving abstraction vs. exploratory remote-association sampling) is not currently reflected as two separate mechanisms with different confidence treatment in akm's description — collapsing them into one pipeline loses a distinction the biology treats as functionally and neuromodulator-distinct.

---

## Section 9: Procedural/Skill Learning, Basal Ganglia, Chunking, Automaticity

**(a) Established findings**

Squire (2004) synthesizes the case (from H.M. and subsequent lesion/imaging work) for dissociable long-term memory systems: declarative memory (facts, events; hippocampus/MTL-dependent, consciously accessible) versus nondeclarative memory, including procedural/skill and habit learning (basal ganglia/striatum-dependent), expressed through performance rather than conscious recollection, acquired incrementally and largely independent of explicit awareness.

Graybiel (1998) proposes the mechanism: corticostriatal circuits recode extended action/cognitive sequences into compact, reusable "chunks," generalizing Miller's (1956) working-memory chunking concept to action-sequence control. Repetition shifts execution from effortful, cortically-controlled step-by-step processing to a compressed, striatally-mediated unit triggerable with reduced cognitive load — a mechanistic account of skill automatization; striatal single-unit recordings (e.g., Jog et al. 1999) show firing patterns reorganizing to bracket the start/end of a learned sequence with practice.

Graybiel (2008) extends this: once chunked/habitual, actions become comparatively insensitive to the action's outcome value (the classic goal-directed vs. habitual dissociation, from outcome-devaluation experiments) — a compiled unit executes largely independent of ongoing value recomputation, and striatal evaluative/dopaminergic signaling governs when/how such routines are reinforced and modulates the shift from deliberative to cached procedural control.

**(b) Key citations**

- Squire, L. R. (2004). "Memory systems of the brain: A brief history and current perspective." *Neurobiology of Learning and Memory*, 82(3), 171–177. http://whoville.ucsd.edu/PDFs/384_Squire_%20NeurobiolLearnMem2004.pdf
- Graybiel, A. M. (1998). "The Basal Ganglia and Chunking of Action Repertoires." *Neurobiology of Learning and Memory*, 70(1–2), 119–136. https://doi.org/10.1006/nlme.1998.3843 · https://pubmed.ncbi.nlm.nih.gov/9753592/
- Graybiel, A. M. (2008). "Habits, Rituals, and the Evaluative Brain." *Annual Review of Neuroscience*, 31, 359–387. https://doi.org/10.1146/annurev.neuro.29.051605.112851 · https://pubmed.ncbi.nlm.nih.gov/18558860/

**(c) Computational principle for an engineered system**

Procedural compilation should be a frequency/repetition-triggered compression of an *ordered sequence* of operations into a single reusable atomic unit — not just semantically similar content. Chunking is a tradeoff, not a pure win: compiled chunks execute cheaply but become comparatively insensitive to updated outcome value, so an engineered analogue needs a path to reassess or "de-compile" a chunk if its cached value diverges from actual outcomes. The dopaminergic/evaluative signal governing *which* sequences get reinforced/compiled should be kept as a distinct control signal from the chunk's internal content.

**(d) Alignment with akm**

This is the most directly biologically-grounded of akm's mechanisms surveyed. "Repeated action sequences → procedural knowledge" faithfully names Graybiel's (1998) corticostriatal chunking mechanism, and Squire's declarative/nondeclarative distinction supports treating akm's "procedural knowledge" as a genuinely different memory kind, not just a labeling convenience.

Divergence: the biology's chunking is inseparable from a *value/evaluative* component — habits form and strengthen as a function of outcome reinforcement, and become *less* responsive to devalued outcomes once compiled. If akm's procedural compilation triggers purely on repetition-frequency without incorporating a success/outcome signal — compiling a sequence into "known-good procedure" regardless of whether it actually led to good outcomes — that diverges from the biology functionally: real procedural learning is repetition-*and*-reinforcement gated, not repetition-only gated, and skipping the value gate risks compiling frequently-used-but-ineffective sequences into cached procedural knowledge. The biology also offers no clean solution for safely *revising* a compiled chunk once conditions change (habitual insensitivity to devaluation is a known biological failure mode, not a feature to imitate) — this tells an engineered system the tradeoff exists, not how to solve it.

---

## Section 10: Reconsolidation and Belief Revision

**(a) Established findings**

Nader, Schafe & LeDoux (2000) demonstrated that consolidated memories are not permanently fixed: in rats with a well-consolidated auditory fear memory, infusing a protein-synthesis inhibitor into the basolateral amygdala immediately after the memory was *reactivated* abolished the fear memory on subsequent tests; the same infusion without reactivation, or into an unrelated structure, had no effect. Retrieval returns a consolidated memory to a transient, protein-synthesis-dependent labile state ("reconsolidation") functionally analogous to original consolidation.

Follow-up boundary-conditions work substantially qualifies this: Sevenster, Beckers & Kindt (2013, *Science*) showed destabilization requires the retrieval episode to contain a genuine **prediction error** — some mismatch between expectation and what actually occurs during retrieval — and prediction error, while necessary, is not sufficient alone; memory strength/age and degree of overtraining are further boundary conditions (reviewed in Nader & Einarsson 2010). Strong, old, or heavily overtrained memories are comparatively resistant to reconsolidation-based updating.

**(b) Key citations**

- Nader, K., Schafe, G. E., & LeDoux, J. E. (2000). "Fear memories require protein synthesis in the amygdala for reconsolidation after retrieval." *Nature*, 406, 722–726. https://doi.org/10.1038/35021052
- Sevenster, D., Beckers, T., & Kindt, M. (2013). "Prediction Error Governs Pharmacologically Induced Amnesia for Learned Fear." *Science*, 339(6121), 830–833. https://science.sciencemag.org/content/339/6121/830.abstract · https://kindtclinics.com/wp-content/uploads/2020/08/Sevenster-et-al-2013_Science.pdf
- Nader, K., & Einarsson, E. O. (2010). "Memory reconsolidation: an update." *Annals of the New York Academy of Sciences*, 1191(1), 27–41. https://nyaspubs.onlinelibrary.wiley.com/doi/abs/10.1111/j.1749-6632.2010.05443.x
- **UNVERIFIED (venue not independently cross-checked)**: Sevenster, D., Beckers, T., & Kindt, M. (2014). "Prediction error demarcates the transition from retrieval, to reconsolidation, to new learning." PMC record located (https://pmc.ncbi.nlm.nih.gov/articles/PMC4201815/) confirming the finding, but the exact journal/volume was not independently confirmed against a publisher page in this pass — re-check before citing as settled.

**(c) Computational principle for an engineered system**

Model belief revision as **retrieval-triggered destabilization gated by prediction error**, not unconditional overwrite-on-contradiction: an existing belief should be reopened for revision only when it is retrieved *and* the retrieval context contains a genuine mismatch with current evidence — not merely because a topically related new item appeared. Belief revision should have graded resistance based on the target belief's reinforcement history and age — a well-established belief should require a larger or more repeated prediction-error signal to revise than a weak, recent one; a single contradicting data point should accumulate evidence rather than automatically overwrite. Once destabilized, the update itself should be a new consolidation event with its own stabilization dynamics, not an instantaneous atomic overwrite.

**(d) Alignment with akm**

akm's **contradiction detection / belief revision** is directionally aligned with reconsolidation's core insight: consolidated memory is not immutable and is revisable specifically at moments of retrieval/re-engagement.

Divergences — the single most important one to flag: reconsolidation requires the destabilizing event to be a *prediction-error-bearing retrieval* of the specific memory, not just any contradiction encounter, and even then is gated by strength/age boundary conditions. If akm's contradiction detection revises a belief simply because a semantically contradicting new memory is *written* (a passive detect-and-flag pattern) rather than requiring the original belief to be actively retrieved/engaged under mismatch conditions, it is missing the retrieval-gating step the biology treats as essential. Second, without graded resistance by reinforcement count/age, a well-established, many-times-corroborated belief could in principle be overwritten by a single low-quality contradicting data point as easily as a belief formed yesterday — biologically implausible and likely undesirable for reliability; this is a concrete, citable gap to check against akm's actual implementation.

---

## Synthesis: Mechanism-by-Mechanism Fidelity Map

| akm mechanism | Nearest neuroscience analogue | Fidelity | Most important divergence |
|---|---|---|---|
| Encoding salience (novelty × magnitude × prediction-error) | Hippocampal-VTA loop novelty/mismatch signal (Lisman & Grace 2005) + dopamine RPE (Schultz et al. 1997) + synaptic tagging (Frey & Morris 1997) | **Partial** | Folds two distinct dopaminergic functions (novelty vs. reward-prediction-error) into one multiplicative score; no time-windowed "rescue" of low-salience items near high-salience ones, unlike STC/behavioral tagging |
| Outcome/feedback loop (prediction-error-shaped value updates) | Dopamine RPE / TD learning (Schultz, Dayan & Montague 1997; Sutton & Barto) | **Strong** | Likely single-step episodic update rather than full TD credit propagation/migration to earlier reliable predictors |
| Retrieval-strength decay with recency | Bjork & Bjork (1992) retrieval-strength/storage-strength theory; spacing effect (Cepeda et al. 2006) | **Partial** | Biology requires *two* dissociated strengths (storage vs. retrieval); a single decaying score conflates them, and biology's optimal decay/reinforcement schedule scales with retention horizon rather than being a flat constant |
| Homeostatic demotion (periodic downscaling of stale memories) | Synaptic Homeostasis Hypothesis / sleep-dependent downscaling (Tononi & Cirelli 2003, 2014) | **Strong (structure) / Partial (mechanism)** | SHY's downscaling is proportional/multiplicative and preserves relative strength; a flat/uniform demotion rule would be a materially weaker implementation of the same idea |
| Consolidation (merging near-duplicates) | Schema-consistent consolidation, assimilation vs. differentiation (Tse et al. 2007; Preston & Eichenbaum 2013) | **Partial** | Biology's merge criterion is congruence with an evolving abstract schema, not pairwise surface/embedding similarity; risks over-merging items that are similar but not truly congruent |
| Recombination ("REM-like" clustering + generalization + multi-run confirmation) | REM/NREM sleep replay and abstraction (Stickgold & Walker 2013; Lewis, Knoblich & Poe 2018) | **Loose** | **The single biggest engineering/biology gap in the whole system**: biological generalization is graded and probabilistic, accumulating confidence over many replay events with no discrete gate; akm's "multi-run hypothesis confirmation before promotion" is a deliberate, non-biological safety addition and should be presented to the review panel as such, not as a faithful mechanism |
| Procedural compilation (repeated sequences → procedural knowledge) | Corticostriatal chunking, basal ganglia habit learning (Graybiel 1998, 2008; Squire 2004) | **Strong (naming) / Partial (gating)** | Biological chunking is repetition-*and*-outcome-reinforcement gated, not repetition-only; without a value/outcome gate, akm risks compiling frequently-used-but-ineffective sequences into "trusted" procedural knowledge |
| Proactive maintenance (periodic review of stale assets) | Offline consolidation windows; prioritized replay (Wilson & McNaughton 1994; Mattar & Daw 2018) | **Partial** | Biological replay prioritizes by gain × need (expected decision-utility recomputed at replay time), not primarily by staleness/recency of the item |
| Contradiction detection / belief revision | Memory reconsolidation gated by prediction error (Nader, Schafe & LeDoux 2000; Sevenster, Beckers & Kindt 2013) | **Partial** | Biology requires *active retrieval under mismatch* of the specific target memory to destabilize it, plus strength/age-graded resistance; a passive "new memory contradicts old memory" trigger without retrieval-gating or graded resistance is a materially looser mechanism |

**The most consequential divergence overall** is in **recombination**: akm's discrete "multi-run hypothesis confirmation before promotion" step has no counterpart in the sleep/replay literature, which describes continuous, graded, probabilistic generalization rather than a pass/fail confirmation gate. This is not necessarily a flaw — as an engineering safety mechanism against promoting spurious one-off correlations into permanent belief, it may well be the *right* design choice — but the review panel should be told explicitly that this specific piece of the system is a deliberate engineering departure from, not a faithful implementation of, the neuroscience it is named after. The second most consequential gap is the *absence of an outcome/value gate* in procedural compilation and the *absence of retrieval-gating and strength/age-graded resistance* in contradiction detection — both real neuroscience mechanisms (Graybiel 2008's evaluative brain; Sevenster/Beckers/Kindt's prediction-error and boundary-condition work) that, if missing from akm's implementation, represent concrete, addressable fidelity gaps rather than fundamental incompatibilities.

---

## Notes on Citation Verification

All citations above were checked via live web search/fetch against publisher pages, PubMed, PMC, or author-hosted PDFs during this research pass, except where explicitly marked **UNVERIFIED** or **PLAUSIBLE (not independently re-verified)**:

- The exact "Düzel et al. 2010" human-imaging paper referenced in the original research brief (Section 3) could not be pinned to one canonical source; the NOMAD review is offered as the closest well-attested match.
- Montague, Dayan & Sejnowski (1996) (Section 4) is corroborated by search results but was not independently fetched against the primary journal record in this pass.
- The 2014 Sevenster, Beckers & Kindt follow-up paper (Section 10) exists per PMC record but its exact journal/venue was not cross-checked against a publisher page.
- The "67% forgotten within 24 hours" figure sometimes attached to Ebbinghaus's curve (Section 5) is a common paraphrase without a pinned primary-source citation.

Anyone citing this document in a formal deliverable should re-verify the flagged items against primary publisher records before treating them as settled.
