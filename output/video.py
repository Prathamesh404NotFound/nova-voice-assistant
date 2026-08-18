from manim import *
import numpy as np

# Nova brand palette (matches hud.css design tokens)
NOVA_BG = "#020306"
NOVA_CYAN = "#39D2FF"
NOVA_CYAN_DIM = "#1E6D85"
NOVA_GREEN = "#83C167"
NOVA_RED = "#FF6B6B"
NOVA_TEXT = "#E8EDF3"
NOVA_DIM = "#8A94A6"

FONT_DISPLAY = "Orbitron"
FONT_BODY = "Space Grotesk"
FONT_MONO = "JetBrains Mono"

# ---- shared helpers ----

def make_orb(radius=1.0, color=NOVA_CYAN, stroke_width=2.5):
    """Central glowing orb: core disc + concentric rings (matches HUD canvas)."""
    core = Circle(radius=radius * 0.42, color=color, fill_opacity=0.9, stroke_width=0)
    ring1 = Circle(radius=radius * 0.68, color=color, stroke_width=stroke_width)
    ring2 = Circle(radius=radius, color=color, stroke_width=stroke_width * 0.7)
    ring2.set_stroke(opacity=0.75)
    ring3 = Circle(radius=radius * 1.32, color=color, stroke_width=stroke_width * 0.5)
    ring3.set_stroke(opacity=0.45)
    return core, VGroup(ring1, ring2, ring3)


def rotating_updater(m, dt, rate=1.0):
    m.rotate(rate * dt * PI / 3)


def make_waveform(n=10, width=5.5, color=NOVA_CYAN):
    """Live-transcript style waveform bar group (HUD style)."""
    bars = VGroup()
    x = -width / 2
    step = width / (n - 1)
    for i in range(n):
        bar = RoundedRectangle(width=0.09, height=0.35, corner_radius=0.04,
                               color=color, fill_opacity=0.9, stroke_width=0)
        bar.move_to(np.array([x, 0, 0]))
        bars.add(bar)
        x += step
    bars.center()
    return bars


class Scene1Hook(Scene):
    # Target: 10.1s (scene1_hook.wav measures 9.08s)
    def setup(self):
        self.camera.background_color = NOVA_BG

    def construct(self):
        title = Text("NOVA", font=FONT_DISPLAY, font_size=72,
                     color=NOVA_CYAN, weight=BOLD)
        title.to_edge(UP, buff=0.7)
        subtitle = Text("Meet your desktop's new voice", font=FONT_BODY,
                        font_size=34, color=NOVA_TEXT)
        subtitle.next_to(title, DOWN, buff=0.25)

        core, rings = make_orb(radius=1.55)
        core.save_state()
        rings.add_updater(lambda m, dt: m.rotate(0.16 * PI / 3 * dt))

        # Waveform below the orb
        wave = make_waveform(n=12, width=6.0)
        wave.move_to(3.0 * DOWN)

        # Transcript line
        transcript = Text('"Nova, open my downloads"', font=FONT_MONO,
                          font_size=28, color=NOVA_TEXT)
        transcript.move_to(2.25 * DOWN)
        transcript.set_opacity(0)

        self.play(GrowFromCenter(core), run_time=1.2)
        self.play(FadeIn(rings, shift=0.2 * UP), FadeIn(wave),
                  Write(transcript, run_time=1.6), run_time=1.6)
        self.play(Write(title, run_time=1.1), run_time=1.1)
        self.play(FadeIn(subtitle, shift=0.15 * DOWN), run_time=0.8)

        # Pulsing core + waveform animation during narration
        for i in range(12):
            h = 0.35 + 1.5 * abs(np.sin(i * 0.9 + np.arange(12) * 1.1))
            h = np.clip(h, 0.3, 2.6)
            self.play(
                *[b.animate.stretch_to_fit_height(hv) for b, hv in zip(wave, h)],
                core.animate.set_fill(opacity=0.75 + 0.15 * (1 - i % 3 / 2)),
                run_time=0.3, rate_func=linear,
            )
        self.play(
            *[b.animate.stretch_to_fit_height(0.35) for b in wave],
            run_time=0.6, rate_func=smooth,
        )
        self.wait(1.2)


class Scene2Pipeline(Scene):
    # Target: 17.3s (scene2_pipeline.wav measures 16.24s)
    def setup(self):
        self.camera.background_color = NOVA_BG

    def construct(self):
        title = Text("The Voice Pipeline", font=FONT_DISPLAY, font_size=52,
                     color=NOVA_CYAN)
        title.to_edge(UP, buff=0.55)

        # Stage nodes, left to right
        mic_node = RoundedRectangle(width=1.9, height=1.35, corner_radius=0.18,
                                    color=NOVA_CYAN, stroke_width=3)
        mic_icon = Text("\U0001F399", font_size=34)  # microphone emoji fallback below
        mic_label = Text("Voice", font=FONT_BODY, font_size=30, color=NOVA_TEXT)
        mic_grp = VGroup(mic_icon, mic_label).arrange(DOWN, buff=0.1)
        mic_node.add(mic_grp)

        intent_node = RoundedRectangle(width=1.9, height=1.35, corner_radius=0.18,
                                       color=NOVA_CYAN_DIM, stroke_width=3)
        intent_label = Text("Intent", font=FONT_BODY, font_size=30, color=NOVA_TEXT)
        intent_node.add(intent_label)

        plan_node = RoundedRectangle(width=1.9, height=1.35, corner_radius=0.18,
                                     color=NOVA_CYAN_DIM, stroke_width=3)
        plan_label = Text("Plan", font=FONT_BODY, font_size=30, color=NOVA_TEXT)
        plan_node.add(plan_label)

        action_node = RoundedRectangle(width=1.9, height=1.35, corner_radius=0.18,
                                       color=NOVA_CYAN_DIM, stroke_width=3)
        action_label = Text("Act", font=FONT_BODY, font_size=30, color=NOVA_TEXT)
        action_node.add(action_label)

        for _n in (mic_node, intent_node, plan_node, action_node):
            _n.fill_opacity = 0.18
            _n.set_fill(opacity=0.18)
        nodes = VGroup(mic_node, intent_node, plan_node, action_node)
        nodes.arrange(RIGHT, buff=1.15)
        nodes.set_y(0.55)

        # Arrows between nodes
        arrows = VGroup()
        for a, b in zip(nodes[:-1], nodes[1:]):
            ar = Arrow(a.get_right(), b.get_left(), buff=0.14,
                       color=NOVA_CYAN, stroke_width=4, max_tip_length_to_length_ratio=0.35)
            arrows.add(ar)

        # Transcript example under mic
        example = Text('"open my downloads"', font=FONT_MONO, font_size=24,
                       color=NOVA_DIM)
        example.next_to(mic_node, DOWN, buff=0.2)

        # Risk ladder on the right side
        ladder_title = Text("Risk Levels", font=FONT_BODY, font_size=26,
                            color=NOVA_TEXT, weight=BOLD)
        rows = VGroup()
        levels = [
            ("L0  Read", "immediate", NOVA_GREEN),
            ("L1  Safe", "immediate", NOVA_GREEN),
            ("L2  Reversible", "5 s toast", NOVA_CYAN),
            ("L3  Sensitive", "confirm modal", NOVA_CYAN),
            ("L4  Destructive", "confirm modal", NOVA_RED),
        ]
        for label, gate, col in levels:
            row = VGroup(
                Text(label, font=FONT_MONO, font_size=21, color=col),
                Text(gate, font=FONT_BODY, font_size=21, color=NOVA_DIM),
            )
            row.arrange(RIGHT, buff=0.25)
            rows.add(row)
        rows.arrange(DOWN, buff=0.22, aligned_edge=LEFT)
        ladder = VGroup(ladder_title, rows).arrange(DOWN, buff=0.18, aligned_edge=LEFT)
        ladder.scale(0.92)
        ladder.move_to(2.55 * DOWN + 4.1 * RIGHT)
        ladder.shift(0.35 * LEFT)

        ladder_frame = SurroundingRectangle(
            ladder, color=NOVA_DIM, corner_radius=0.15, buff=0.25, stroke_width=1.5)

        self.play(Write(title), run_time=0.8)
        self.play(GrowFromCenter(mic_node), run_time=0.7)
        self.play(FadeIn(example, shift=0.15 * UP), run_time=0.5)
        self.play(arrows[0].animate.put_start_and_end_on(
            mic_node.get_right(), intent_node.get_left()), run_time=0.3)
        self.play(FadeIn(intent_node, shift=0.15 * RIGHT), run_time=0.6)
        self.play(arrows[1].animate.put_start_and_end_on(
            intent_node.get_right(), plan_node.get_left()), run_time=0.3)
        self.play(FadeIn(plan_node, shift=0.15 * RIGHT), run_time=0.6)
        self.play(arrows[2].animate.put_start_and_end_on(
            plan_node.get_right(), action_node.get_left()), run_time=0.3)
        self.play(FadeIn(action_node, shift=0.15 * RIGHT), run_time=0.6)
        self.play(FadeIn(ladder_frame), *[FadeIn(r, shift=0.1 * RIGHT)
                                          for r in ladder], run_time=1.4)

        # Emphasize L2 row (toast) and L3/L4 rows (modal)
        self.play(Indicate(rows[2], color=NOVA_CYAN, scale_factor=1.1), run_time=0.9)
        self.play(Indicate(rows[3], color=NOVA_CYAN, scale_factor=1.1),
                  Indicate(rows[4], color=NOVA_RED, scale_factor=1.1), run_time=1.0)

        # Flash action node to close
        self.play(Circumscribe(action_node, color=NOVA_CYAN, run_time=1.2))
        self.wait(5.3)


class Scene3KnowledgeBase(Scene):
    # Target: 14.3s (scene3_kb.wav measures 13.28s)
    def setup(self):
        self.camera.background_color = NOVA_BG

    def construct(self):
        title = Text("Local Knowledge Base", font=FONT_DISPLAY, font_size=50,
                     color=NOVA_CYAN)
        title.to_edge(UP, buff=0.55)

        # Left: folder
        folder = RoundedRectangle(width=1.7, height=1.25, corner_radius=0.14,
                                  color=NOVA_CYAN_DIM, stroke_width=3)
        folder_tab = Rectangle(width=0.6, height=0.22, color=NOVA_CYAN_DIM,
                               stroke_width=0).move_to(
            np.array([-0.55, 0.52, 0])).shift(folder.get_center() - folder.get_center())
        folder_tab.move_to(folder.get_corner(UL) + np.array([0.3, 0.11, 0]))
        folder_lbl = Text("Your folders", font=FONT_BODY, font_size=26,
                          color=NOVA_TEXT)
        folder.add(folder_tab, folder_lbl)
        folder.move_to(4.6 * LEFT)

        # Middle: chunk cards
        chunks = VGroup()
        for i, label in enumerate(["chunk 1", "chunk 2", "chunk 3"]):
            card = RoundedRectangle(width=1.55, height=0.62, corner_radius=0.1,
                                    color=NOVA_CYAN, stroke_width=2)
            t = Text(label, font=FONT_MONO, font_size=20, color=NOVA_BG)
            card.add(t)
            chunks.add(card)
        chunks.arrange(DOWN, buff=0.18)
        chunks.move_to(1.6 * LEFT)

        # Right: local embeddings node
        embed_node = RoundedRectangle(width=2.1, height=1.4, corner_radius=0.16,
                                      color=NOVA_GREEN, stroke_width=3)
        embed_lbl = Text("Embeddings", font=FONT_BODY, font_size=28, color=NOVA_BG)
        embed_sub = Text("100% local", font=FONT_MONO, font_size=20, color=NOVA_BG)
        embed_node.set_fill(opacity=0.22)
        embed_node.add(VGroup(embed_lbl, embed_sub).arrange(DOWN, buff=0.12))
        embed_node.move_to(1.6 * RIGHT)

        # Far right: answer with citation
        answer_box = RoundedRectangle(width=2.5, height=1.6, corner_radius=0.16,
                                      color=NOVA_CYAN, stroke_width=3)
        ans_lbl = Text("Answer", font=FONT_BODY, font_size=28, color=NOVA_TEXT)
        src = Text("sources: answer.md", font=FONT_MONO, font_size=18,
                   color=NOVA_DIM)
        answer_box.set_fill(opacity=0.15)
        answer_box.add(VGroup(ans_lbl, src).arrange(DOWN, buff=0.15))
        answer_box.move_to(4.7 * RIGHT)

        arrows = VGroup()
        a1 = Arrow(folder.get_right(), chunks.get_left(), buff=0.15,
                   color=NOVA_CYAN, stroke_width=4, max_tip_length_to_length_ratio=0.4)
        a2 = Arrow(chunks.get_right(), embed_node.get_left(), buff=0.15,
                   color=NOVA_CYAN, stroke_width=4, max_tip_length_to_length_ratio=0.4)
        a3 = Arrow(embed_node.get_right(), answer_box.get_left(), buff=0.15,
                   color=NOVA_GREEN, stroke_width=4, max_tip_length_to_length_ratio=0.4)
        arrows.add(a1, a2, a3)

        # Query arrow coming from below into embed_node
        query = Text('"what did I write about X?"', font=FONT_MONO, font_size=22,
                     color=NOVA_TEXT)
        query.move_to(embed_node.get_center() + 1.9 * DOWN)
        q_arrow = Arrow(query.get_top(), embed_node.get_bottom(), buff=0.15,
                        color=NOVA_TEXT, stroke_width=3, max_tip_length_to_length_ratio=0.4)

        self.play(Write(title), run_time=0.8)
        self.play(FadeIn(folder, shift=0.15 * RIGHT), run_time=0.7)
        self.play(a1.animate.put_start_and_end_on(
            folder.get_right(), chunks.get_left()), run_time=0.3)
        self.play(*[FadeIn(c, shift=0.15 * RIGHT) for c in chunks],
                  lag_ratio=0.25, run_time=0.9)
        self.play(a2.animate.put_start_and_end_on(
            chunks.get_right(), embed_node.get_left()), run_time=0.3)
        self.play(FadeIn(embed_node, shift=0.15 * RIGHT), run_time=0.7)
        self.play(Write(query), q_arrow.animate.put_start_and_end_on(
            query.get_top(), embed_node.get_bottom()), run_time=1.0)
        self.play(a3.animate.put_start_and_end_on(
            embed_node.get_right(), answer_box.get_left()), run_time=0.3)
        self.play(FadeIn(answer_box, shift=0.15 * RIGHT), run_time=0.7)

        # Emphasize "100% local"
        self.play(Circumscribe(embed_sub, color=NOVA_GREEN, run_time=1.1))
        self.wait(1.2)
        self.play(Indicate(src, color=NOVA_CYAN, scale_factor=1.15), run_time=0.9)
        self.wait(5.1)


class Scene4Privacy(Scene):
    # Target: 16.9s (scene4_privacy.wav measures 15.92s)
    def setup(self):
        self.camera.background_color = NOVA_BG

    def construct(self):
        title = Text("Your Data Stays Yours", font=FONT_DISPLAY, font_size=40,
                     color=NOVA_CYAN)
        title.to_edge(UP, buff=0.55)

        # Private badge (top-right, HUD style)
        badge = RoundedRectangle(width=2.6, height=0.62, corner_radius=0.12,
                                 color=NOVA_GREEN, stroke_width=2.5,
                                 fill_color=NOVA_GREEN, fill_opacity=0.9)
        badge_lbl = Text("PRIVATE", font=FONT_MONO, font_size=24,
                         color=NOVA_BG, weight=BOLD)
        badge.add(badge_lbl)
        badge.move_to(3.0 * RIGHT + 1.9 * UP)

        # Shield at center-left
        shield = self._make_shield()
        shield.move_to(2.6 * LEFT + 0.2 * DOWN)
        shield_lbl = Text("On-device", font=FONT_BODY, font_size=30,
                          color=NOVA_TEXT)
        shield_lbl.next_to(shield, DOWN, buff=0.3)

        # Laptop/device on the right (simple)
        device = RoundedRectangle(width=2.4, height=1.5, corner_radius=0.14,
                                  color=NOVA_CYAN_DIM, stroke_width=3)
        items = ["notes", "files", "screen"]
        dev_items = VGroup(*[Text(i, font=FONT_MONO, font_size=20,
                                  color=NOVA_TEXT) for i in items])
        dev_items.arrange(DOWN, buff=0.08)
        device.add(dev_items)
        device.move_to(4.4 * RIGHT + 0.2 * DOWN)

        # Outbound arrow from device, blocked by shield
        arrow = Arrow(device.get_left() + 0.35 * UP, shield.get_right(),
                      buff=0.2, color=NOVA_RED, stroke_width=4,
                      max_tip_length_to_length_ratio=0.35)
        x_mark = Text("\u2716", font_size=44, color=NOVA_RED)

        # Bottom tagline
        tag = Text("Your files. Your notes. Your screen. Yours.",
                   font=FONT_BODY, font_size=30, color=NOVA_TEXT)
        tag.move_to(3.2 * DOWN)

        self.play(Write(title), run_time=0.8)
        self.play(FadeIn(badge, shift=0.1 * DOWN), run_time=0.6)
        self.play(FadeIn(device, shift=0.15 * LEFT), run_time=0.7)
        self.play(GrowFromCenter(shield), FadeIn(shield_lbl), run_time=1.0)
        self.play(arrow.animate.put_start_and_end_on(
            device.get_left() + 0.35 * UP, shield.get_right()), run_time=1.6)
        self.play(FadeIn(x_mark, scale=1.6), run_time=0.5)
        self.play(Circumscribe(shield, color=NOVA_GREEN, run_time=1.3))
        self.wait(1.9)
        self.play(Write(tag), run_time=1.8)
        self.wait(5.6)

    @staticmethod
    def _make_shield(color=NOVA_GREEN, size=1.5):
        """Shield icon from arcs and a triangle tip."""
        top = Arc(radius=size, angle=PI, start_angle=0, color=color,
                  stroke_width=6)
        side_l = Line(start=top.get_left(), end=np.array([0, -size * 1.25, 0]),
                      color=color, stroke_width=6)
        side_r = Line(start=top.get_right(), end=np.array([0, -size * 1.25, 0]),
                      color=color, stroke_width=6)
        shield = VGroup(top, side_l, side_r)
        lock = VGroup(
            RoundedRectangle(width=0.42, height=0.34, corner_radius=0.08,
                             color=color, stroke_width=0, fill_opacity=0.9),
            Arc(radius=0.14, angle=PI, start_angle=0, color=color,
                stroke_width=4).shift(0.17 * UP),
        )
        lock.move_to(shield.get_center())
        shield.add(lock)
        return shield


class Scene5Outro(Scene):
    # Target: 16.2s (scene5_outro.wav measures 15.16s)
    def setup(self):
        self.camera.background_color = NOVA_BG

    def construct(self):
        title = Text("Automations", font=FONT_DISPLAY, font_size=50,
                     color=NOVA_CYAN)
        title.to_edge(UP, buff=0.55)

        # Clock
        clock = Circle(radius=1.05, color=NOVA_CYAN, stroke_width=4)
        ticks = VGroup()
        for k in range(12):
            ang = k * PI / 6
            p_in = np.array([0.82 * np.cos(ang), 0.82 * np.sin(ang), 0])
            p_out = np.array([0.98 * np.cos(ang), 0.98 * np.sin(ang), 0])
            ticks.add(Line(p_in, p_out, color=NOVA_CYAN, stroke_width=3))
        hand = Line(ORIGIN, 0.62 * UP, color=NOVA_CYAN, stroke_width=5)
        clock_grp = VGroup(clock, ticks, hand)
        clock_grp.move_to(3.6 * LEFT + 0.3 * DOWN)
        clock_lbl = Text("every weekday 8 AM", font=FONT_MONO, font_size=22,
                         color=NOVA_TEXT)
        clock_lbl.next_to(clock_grp, DOWN, buff=0.35)

        # Example command
        cmd = Text('"tell me my tasks and check my downloads"',
                   font=FONT_MONO, font_size=24, color=NOVA_DIM)
        cmd.next_to(clock_lbl, DOWN, buff=0.35)

        # Routine chain
        chain_steps = [
            ("scan tasks", NOVA_CYAN),
            ("scan downloads", NOVA_CYAN),
            ("notify", NOVA_GREEN),
            ("speak", NOVA_GREEN),
        ]
        step_cards = VGroup()
        for label, col in chain_steps:
            card = RoundedRectangle(width=1.55, height=0.7, corner_radius=0.12,
                                    color=col, stroke_width=2.5)
            t = Text(label, font=FONT_MONO, font_size=21, color=NOVA_BG)
            card.add(t)
            step_cards.add(card)
        step_cards.arrange(RIGHT, buff=0.3)
        step_cards.move_to(3.4 * RIGHT + 0.3 * DOWN)

        chain_arrows = VGroup()
        for a, b in zip(step_cards[:-1], step_cards[1:]):
            chain_arrows.add(Arrow(a.get_right(), b.get_left(), buff=0.12,
                                   color=NOVA_DIM, stroke_width=3,
                                   max_tip_length_to_length_ratio=0.4))

        self.play(Write(title), run_time=0.8)
        self.play(GrowFromCenter(clock), FadeIn(ticks),
                  hand.animate.rotate(-PI / 2, about_point=ORIGIN), run_time=1.0)
        self.play(Write(clock_lbl), run_time=0.7)
        self.play(Write(cmd), run_time=1.0)
        self.play(*[FadeIn(c, shift=0.1 * RIGHT) for c in step_cards],
                  *[Create(a) for a in chain_arrows],
                  lag_ratio=0.2, run_time=1.3)

        # Fire the chain sequentially with a highlight sweep
        for card in step_cards:
            self.play(Circumscribe(card, color=NOVA_CYAN, run_time=0.65))
        self.wait(1.4)

        # Transition to final brand screen
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.8)

        core, rings = make_orb(radius=1.05)
        core.move_to(1.5 * UP)
        rings.add_updater(lambda m, dt: m.rotate(0.16 * PI / 3 * dt))
        final_title = Text("NOVA", font=FONT_DISPLAY, font_size=60,
                           color=NOVA_CYAN, weight=BOLD)
        final_title.move_to(0.35 * UP)
        tagline = Text("Your desktop, finally fluent.", font=FONT_BODY,
                       font_size=30, color=NOVA_TEXT)
        tagline.move_to(0.9 * DOWN)
        repo = Text("github.com/Prathamesh404NotFound/nova-voice-assistant",
                    font=FONT_MONO, font_size=19, color=NOVA_DIM)
        repo.move_to(3.3 * DOWN)

        self.play(GrowFromCenter(core), FadeIn(rings), run_time=1.1)
        self.play(Write(final_title), run_time=1.1)
        self.play(FadeIn(tagline, shift=0.15 * DOWN), run_time=0.9)
        self.play(FadeIn(repo, shift=0.1 * DOWN), run_time=0.8)
        self.wait(1.4)
