"""Pure SVG rendering from detached memory snapshots and generation traces."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from html import escape

from .phrase_formatting import _pitch_label
from .schemas import (
    GenerationConstraintsStatus,
    GenerationConstraintState,
    GenerationTraceStep,
)

GRAPH_SELECTION_MODES = {"slice", "all", "most_used", "neighborhood"}


@dataclass(frozen=True)
class GraphSnapshot:
    counts: dict
    memory_count: int
    markov_order: int
    start_symbol: object
    end_symbol: object
    model_label: str = "VO Regular BP order model"


@dataclass(frozen=True)
class _GraphEdge:
    source: tuple[object, ...]
    target: tuple[object, ...]
    symbol: object
    weight: float


def _svg_text_lines(
    lines: list[str],
    *,
    x: float,
    y: float,
    class_name: str,
    anchor: str = "start",
    line_height: int = 14,
) -> str:
    if not lines:
        return ""
    escaped_lines = [escape(line) for line in lines]
    tspans = [
        f'<tspan x="{x:.1f}" dy="{0 if index == 0 else line_height}">{line}</tspan>'
        for index, line in enumerate(escaped_lines)
    ]
    return (
        f'<text class="{class_name}" x="{x:.1f}" y="{y:.1f}" '
        f'text-anchor="{anchor}">{"".join(tspans)}</text>'
    )


def _format_graph_weight(weight: float) -> str:
    if abs(weight - round(weight)) < 0.001:
        return str(int(round(weight)))
    return f"{weight:.2f}".rstrip("0").rstrip(".")


def _constraint_state_label(state: GenerationConstraintState | None) -> str:
    if state is None:
        return "not requested"
    if state.applied:
        return "applied"
    if state.relaxed:
        return "relaxed"
    if state.requested:
        return "requested"
    return "disabled"


class GraphRenderer:
    def __init__(self, snapshot: GraphSnapshot):
        self._snapshot = snapshot

    def _is_start_symbol(self, symbol: object) -> bool:
        try:
            start_symbol = self._snapshot.start_symbol
        except Exception:
            return False
        if symbol is start_symbol:
            return True
        try:
            return bool(symbol == start_symbol)
        except Exception:
            return False

    def _is_end_symbol(self, symbol: object) -> bool:
        try:
            end_symbol = self._snapshot.end_symbol
        except Exception:
            return False
        if symbol is end_symbol:
            return True
        try:
            return bool(symbol == end_symbol)
        except Exception:
            return False

    def _graph_symbol_key(self, symbol: object) -> str:
        if self._is_start_symbol(symbol):
            return "__start__"
        if self._is_end_symbol(symbol):
            return "__end__"
        if isinstance(symbol, str):
            normalized = symbol.strip()
            if normalized in {"START", "<START>"}:
                return "__start__"
            if normalized in {"END", "<END>"}:
                return "__end__"
        return f"{type(symbol).__module__}.{type(symbol).__qualname__}:{repr(symbol)}"

    def _graph_context_key(self, context: tuple[object, ...]) -> str:
        return "|".join(self._graph_symbol_key(symbol) for symbol in context)

    def _graph_symbol_label(self, symbol: object) -> str:
        if self._is_start_symbol(symbol):
            return "START"
        if self._is_end_symbol(symbol):
            return "END"
        if isinstance(symbol, str):
            normalized = symbol.strip()
            if normalized in {"START", "<START>"}:
                return "START"
            if normalized in {"END", "<END>"}:
                return "END"
            return normalized
        if isinstance(symbol, tuple) and len(symbol) == 4:
            try:
                pitch = int(symbol[0])
                duration_bin = int(symbol[1])
                overlaps_left = bool(symbol[2])
                overlaps_right = bool(symbol[3])
                suffixes = []
                if duration_bin:
                    suffixes.append(f"d{duration_bin}")
                if overlaps_left:
                    suffixes.append("L")
                if overlaps_right:
                    suffixes.append("R")
                suffix = f" {'/'.join(suffixes)}" if suffixes else ""
                return f"{_pitch_label(pitch)}{suffix}"
            except (TypeError, ValueError):
                pass
        if hasattr(symbol, "item"):
            try:
                scalar_value = symbol.item()
            except ValueError:
                scalar_value = None
            if isinstance(scalar_value, (bool, int, float, str)):
                return str(scalar_value)
        raw_label = repr(symbol)
        if raw_label.startswith("<") and raw_label.endswith(">"):
            return raw_label[1:-1].upper()
        return raw_label

    def _trace_symbol_label(self, symbol: object) -> str:
        if symbol is None:
            return "none"
        if isinstance(symbol, list):
            symbol = tuple(symbol)
        return self._graph_symbol_label(symbol)

    def _graph_context_label_lines(self, context: tuple[object, ...]) -> list[str]:
        if not context:
            return ["empty"]
        symbol_labels = [self._graph_symbol_label(symbol) for symbol in context]
        if len(symbol_labels) == 1:
            return [self._truncate_graph_label(symbol_labels[0], 24)]
        visible_labels = symbol_labels[-5:]
        prefix = "... " if len(symbol_labels) > len(visible_labels) else ""
        if len(visible_labels) == 2:
            label = f"{prefix}{visible_labels[0]} -> {visible_labels[1]}"
        else:
            label = f"{prefix}{' '.join(visible_labels[:-1])} -> {visible_labels[-1]}"
        return [self._truncate_graph_label(label, 30)]

    @staticmethod
    def _truncate_graph_label(label: str, limit: int) -> str:
        compact = " ".join(str(label).split())
        if len(compact) <= limit:
            return compact
        return f"{compact[: max(1, limit - 3)]}..."

    def _wrap_graph_label(self, label: str, *, limit: int, max_lines: int) -> list[str]:
        words = " ".join(str(label).split()).split(" ")
        lines: list[str] = []
        current = ""
        for word in words:
            candidate = word if not current else f"{current} {word}"
            if len(candidate) <= limit:
                current = candidate
                continue
            if current:
                lines.append(current)
            current = word
            if len(lines) >= max_lines - 1:
                break
        if current and len(lines) < max_lines:
            lines.append(current)
        if len(lines) == max_lines and " ".join(words) != " ".join(lines):
            lines[-1] = self._truncate_graph_label(lines[-1], limit)
        return [self._truncate_graph_label(line, limit) for line in lines] or [
            self._truncate_graph_label(label, limit)
        ]

    def _graph_counts(self):
        return self._snapshot.counts, self._snapshot.model_label

    def _graph_focus_symbol_keys(
        self,
        focus_symbols: list[object] | None,
    ) -> set[str]:
        keys: set[str] = set()
        for symbol in focus_symbols or []:
            if isinstance(symbol, list):
                symbol = tuple(symbol)
            keys.add(self._graph_symbol_key(symbol))
        return keys

    def _graph_context_has_focus(
        self,
        context: tuple[object, ...],
        focus_symbol_keys: set[str],
    ) -> bool:
        if not focus_symbol_keys:
            return False
        return any(
            self._graph_symbol_key(symbol) in focus_symbol_keys for symbol in context
        )

    @staticmethod
    def _successor_context(
        context: tuple[object, ...],
        symbol: object,
        all_contexts: set[tuple[object, ...]],
        kmax: int,
    ) -> tuple[object, ...]:
        tokens = (*context, symbol)
        for order in range(min(kmax, len(tokens)), 0, -1):
            candidate = tuple(tokens[-order:])
            if candidate in all_contexts:
                return candidate
        return (symbol,)

    def render_graph_svg(
        self,
        *,
        max_nodes: int = 96,
        max_edges: int = 220,
        graph_mode: str = "slice",
        order_filter: int | None = None,
        focus_symbols: list[object] | None = None,
    ) -> str:
        graph_counts, model_label = self._graph_counts()
        memory_count = self._snapshot.memory_count
        kmax = max(1, int(self._snapshot.markov_order))
        max_nodes = max(8, min(240, int(max_nodes)))
        max_edges = max(1, min(600, int(max_edges)))
        graph_mode = graph_mode if graph_mode in GRAPH_SELECTION_MODES else "slice"
        if order_filter is not None:
            order_filter = max(1, min(kmax, int(order_filter)))
            graph_counts = {
                context: counter
                for context, counter in graph_counts.items()
                if len(context) == order_filter
            }

        edges: list[_GraphEdge] = []
        all_contexts = set(graph_counts)
        for context, continuations in graph_counts.items():
            for symbol, weight in continuations.items():
                if weight <= 0:
                    continue
                target = self._successor_context(context, symbol, all_contexts, kmax)
                edges.append(
                    _GraphEdge(
                        source=context,
                        target=target,
                        symbol=symbol,
                        weight=float(weight),
                    )
                )

        return self._render_graph_svg(
            model_label=model_label,
            graph_counts=graph_counts,
            edges=edges,
            memory_count=memory_count,
            max_nodes=max_nodes,
            max_edges=max_edges,
            graph_mode=graph_mode,
            order_filter=order_filter,
            focus_symbols=focus_symbols,
        )

    def _render_graph_svg(
        self,
        *,
        model_label: str,
        graph_counts: dict[tuple[object, ...], Counter],
        edges: list[_GraphEdge],
        memory_count: int,
        max_nodes: int,
        max_edges: int,
        graph_mode: str,
        order_filter: int | None,
        focus_symbols: list[object] | None,
    ) -> str:
        context_counts = defaultdict(int)
        for context in graph_counts:
            context_counts[len(context)] += 1

        total_contexts = len(graph_counts)
        total_edges = len(edges)
        selected_nodes: dict[str, tuple[object, ...]] = {}
        selected_edges: list[_GraphEdge] = []
        sorted_contexts = sorted(
            graph_counts,
            key=lambda candidate: (
                len(candidate),
                self._graph_context_key(candidate),
            ),
        )

        def add_node(context: tuple[object, ...]) -> bool:
            key = self._graph_context_key(context)
            if key in selected_nodes:
                return True
            if len(selected_nodes) >= max_nodes:
                return False
            selected_nodes[key] = context
            return True

        def add_edge(edge: _GraphEdge) -> bool:
            if len(selected_edges) >= max_edges:
                return False
            source_key = self._graph_context_key(edge.source)
            target_key = self._graph_context_key(edge.target)
            needed = int(source_key not in selected_nodes) + int(
                target_key not in selected_nodes
            )
            if len(selected_nodes) + needed > max_nodes:
                return False
            add_node(edge.source)
            add_node(edge.target)
            selected_edges.append(edge)
            return True

        default_edge_key = lambda edge: (
            0 if len(edge.source) == 1 else 1,
            -edge.weight,
            len(edge.source),
            self._graph_context_key(edge.source),
            self._graph_context_key(edge.target),
        )

        if graph_mode == "all":
            for context in sorted_contexts:
                if not add_node(context):
                    break
            for edge in sorted(edges, key=default_edge_key):
                if len(selected_edges) >= max_edges:
                    break
                if (
                    self._graph_context_key(edge.source) in selected_nodes
                    and self._graph_context_key(edge.target) in selected_nodes
                ):
                    selected_edges.append(edge)
        elif graph_mode == "most_used":
            for edge in sorted(
                edges,
                key=lambda edge: (
                    -edge.weight,
                    len(edge.source),
                    self._graph_context_key(edge.source),
                    self._graph_context_key(edge.target),
                ),
            ):
                add_edge(edge)
        elif graph_mode == "neighborhood":
            focus_symbol_keys = self._graph_focus_symbol_keys(focus_symbols)
            if focus_symbol_keys:
                focused_contexts = [
                    context
                    for context in sorted_contexts
                    if self._graph_context_has_focus(context, focus_symbol_keys)
                ]
                for context in focused_contexts:
                    add_node(context)
                for edge in sorted(
                    edges,
                    key=lambda edge: (
                        -int(
                            self._graph_context_has_focus(
                                edge.source, focus_symbol_keys
                            )
                        ),
                        -int(
                            self._graph_context_has_focus(
                                edge.target, focus_symbol_keys
                            )
                        ),
                        -edge.weight,
                        len(edge.source),
                        self._graph_context_key(edge.source),
                        self._graph_context_key(edge.target),
                    ),
                ):
                    source_focused = self._graph_context_has_focus(
                        edge.source, focus_symbol_keys
                    )
                    target_focused = self._graph_context_has_focus(
                        edge.target, focus_symbol_keys
                    )
                    if source_focused or target_focused:
                        add_edge(edge)

        if not selected_nodes:
            graph_mode = "slice"

        if graph_mode == "slice":
            for context in sorted_contexts:
                if len(context) > 1:
                    break
                if not add_node(context):
                    break

            for edge in sorted(edges, key=default_edge_key):
                if len(selected_edges) >= max_edges:
                    break
                add_edge(edge)

        width = 1080
        if not selected_nodes:
            height = 520
            return self._render_empty_graph_svg(
                width=width,
                height=height,
                model_label=model_label,
                memory_count=memory_count,
            )

        nodes_by_order: dict[int, list[tuple[object, ...]]] = defaultdict(list)
        for context in selected_nodes.values():
            nodes_by_order[len(context)].append(context)
        for contexts in nodes_by_order.values():
            contexts.sort(key=lambda context: self._graph_context_key(context))

        orders = sorted(nodes_by_order)
        left_margin = 54
        top_margin = 120
        node_width = 106
        node_height = 20
        column_gap = max(
            110, (width - left_margin * 2 - node_width) / max(1, len(orders) - 1)
        )
        row_gap = 7
        max_column_size = max(len(contexts) for contexts in nodes_by_order.values())
        height = max(560, top_margin + max_column_size * (node_height + row_gap) + 84)

        node_positions: dict[str, tuple[float, float]] = {}
        for column_index, order in enumerate(orders):
            contexts = nodes_by_order[order]
            column_x = left_margin + column_index * column_gap
            used_height = (
                len(contexts) * node_height + max(0, len(contexts) - 1) * row_gap
            )
            start_y = top_margin + max(0, (height - top_margin - 86 - used_height) / 2)
            for row_index, context in enumerate(contexts):
                node_positions[self._graph_context_key(context)] = (
                    column_x,
                    start_y + row_index * (node_height + row_gap),
                )

        max_weight = max((edge.weight for edge in selected_edges), default=1.0)
        svg_parts = [
            '<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
            'role="img" aria-labelledby="title desc">',
            '<title id="title">Continuator internal context graph</title>',
            (
                '<desc id="desc">A static graph snapshot of learned Continuator '
                "contexts and continuations.</desc>"
            ),
            "<style>",
            "svg{background:#071217;color:#ecf4ef;font-family:Avenir Next,Segoe UI,Trebuchet MS,sans-serif}",
            ".title{fill:#ecf4ef;font-size:28px;font-weight:750}",
            ".meta{fill:#9bb8b1;font-size:13px}",
            ".order{fill:#6dd3ce;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}",
            ".node{stroke-width:.9;filter:url(#shadow)}",
            ".node-label{fill:#ecf4ef;font-size:5px;font-weight:700}",
            ".edge{fill:none;stroke:#6dd3ce;stroke-opacity:.38}",
            ".edge-label{fill:#f7d3b9;font-size:5px;font-weight:800}",
            ".footer{fill:#9bb8b1;font-size:12px}",
            "</style>",
            "<defs>",
            (
                '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">'
                '<feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#000" flood-opacity=".28"/>'
                "</filter>"
            ),
            (
                '<marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" '
                'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
                '<path d="M 0 0 L 10 5 L 0 10 z" fill="#6dd3ce" fill-opacity=".72"/>'
                "</marker>"
            ),
            "</defs>",
            '<rect x="0" y="0" width="100%" height="100%" fill="#071217"/>',
            (
                '<rect x="24" y="24" width="1032" height="72" rx="18" '
                'fill="#ffffff" fill-opacity=".035" stroke="#ffffff" stroke-opacity=".08"/>'
            ),
            '<text class="title" x="52" y="58">Continuator Memory Graph</text>',
            (
                f'<text class="meta" x="52" y="80">{escape(model_label)} - '
                f"{memory_count} learned phrase{'s' if memory_count != 1 else ''} - "
                f"{total_contexts} contexts - {total_edges} transitions</text>"
            ),
        ]

        for column_index, order in enumerate(orders):
            x = left_margin + column_index * column_gap
            svg_parts.append(
                f'<text class="order" x="{x:.1f}" y="116">ORDER {order}</text>'
            )

        for edge in selected_edges:
            source_key = self._graph_context_key(edge.source)
            target_key = self._graph_context_key(edge.target)
            source_position = node_positions.get(source_key)
            target_position = node_positions.get(target_key)
            if source_position is None or target_position is None:
                continue
            sx = source_position[0] + node_width
            sy = source_position[1] + node_height / 2
            tx = target_position[0]
            ty = target_position[1] + node_height / 2
            if tx <= sx:
                sx = source_position[0] + node_width / 2
                tx = target_position[0] + node_width / 2
                curve = max(64, abs(ty - sy) * 0.5 + 54)
                path = f"M {sx:.1f} {sy:.1f} C {sx + curve:.1f} {sy - curve:.1f}, {tx + curve:.1f} {ty + curve:.1f}, {tx:.1f} {ty:.1f}"
            else:
                curve = max(62, (tx - sx) * 0.42)
                path = f"M {sx:.1f} {sy:.1f} C {sx + curve:.1f} {sy:.1f}, {tx - curve:.1f} {ty:.1f}, {tx:.1f} {ty:.1f}"
            stroke_width = 1.2 + 4.0 * (edge.weight / max_weight) ** 0.5
            svg_parts.append(
                f'<path class="edge" d="{path}" stroke-width="{stroke_width:.2f}" '
                'marker-end="url(#arrow)"/>'
            )
            if len(selected_edges) <= 90:
                lx = (sx + tx) / 2
                ly = (sy + ty) / 2 - 5
                svg_parts.append(
                    f'<text class="edge-label" x="{lx:.1f}" y="{ly:.1f}" '
                    f'text-anchor="middle">{escape(_format_graph_weight(edge.weight))}</text>'
                )

        for key, context in selected_nodes.items():
            x, y = node_positions[key]
            first_symbol = context[0] if context else None
            last_symbol = context[-1] if context else None
            if self._is_start_symbol(first_symbol):
                fill = "#14393d"
                stroke = "#6dd3ce"
            elif self._is_end_symbol(last_symbol):
                fill = "#3b241d"
                stroke = "#f4a261"
            else:
                fill = "#12262d"
                stroke = "#ffffff"
            svg_parts.append(
                f'<rect class="node" x="{x:.1f}" y="{y:.1f}" width="{node_width}" '
                f'height="{node_height}" rx="5" fill="{fill}" stroke="{stroke}"/>'
            )
            label_lines = self._graph_context_label_lines(context)
            svg_parts.append(
                _svg_text_lines(
                    label_lines[:1],
                    x=x + 6,
                    y=y + 13,
                    class_name="node-label",
                    line_height=6,
                )
            )

        truncated_nodes = len(selected_nodes) < total_contexts
        truncated_edges = len(selected_edges) < total_edges
        mode_labels = {
            "slice": "weighted slice",
            "all": "all contexts",
            "most_used": "most-used transitions",
            "neighborhood": "latest phrase neighborhood",
        }
        mode_note = f" - mode: {mode_labels.get(graph_mode, graph_mode)}"
        if order_filter is not None:
            mode_note += f", order {order_filter}"
        truncation_note = ""
        if truncated_nodes or truncated_edges:
            truncation_note = (
                " - showing visible subset"
                f" ({len(selected_nodes)}/{total_contexts} contexts, "
                f"{len(selected_edges)}/{total_edges} transitions)"
            )
        order_summary = ", ".join(
            f"{order}:{count}" for order, count in sorted(context_counts.items())
        )
        svg_parts.append(
            f'<text class="footer" x="52" y="{height - 34}">'
            f"{escape(f'Contexts by order {order_summary}{mode_note}{truncation_note}')}</text>"
        )
        svg_parts.append("</svg>")
        return "\n".join(svg_parts)

    def _render_empty_graph_svg(
        self,
        *,
        width: int,
        height: int,
        model_label: str,
        memory_count: int,
    ) -> str:
        return "\n".join(
            [
                '<svg xmlns="http://www.w3.org/2000/svg" '
                f'viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
                'role="img" aria-labelledby="title desc">',
                '<title id="title">Continuator internal context graph</title>',
                (
                    '<desc id="desc">The Continuator graph is empty because no '
                    "state transitions have been learned yet.</desc>"
                ),
                "<style>",
                "svg{background:#071217;font-family:Avenir Next,Segoe UI,Trebuchet MS,sans-serif}",
                ".title{fill:#ecf4ef;font-size:30px;font-weight:750}",
                ".meta{fill:#9bb8b1;font-size:14px}",
                ".copy{fill:#ecf4ef;font-size:18px;font-weight:700}",
                ".hint{fill:#9bb8b1;font-size:14px}",
                "</style>",
                '<rect x="0" y="0" width="100%" height="100%" fill="#071217"/>',
                (
                    '<rect x="80" y="88" width="920" height="344" rx="28" '
                    'fill="#ffffff" fill-opacity=".04" stroke="#ffffff" stroke-opacity=".1"/>'
                ),
                '<text class="title" x="120" y="148">Continuator Memory Graph</text>',
                (
                    f'<text class="meta" x="120" y="174">{escape(model_label)} - '
                    f"{memory_count} learned phrase{'s' if memory_count != 1 else ''}</text>"
                ),
                '<text class="copy" x="120" y="252">No transitions learned yet.</text>',
                (
                    '<text class="hint" x="120" y="282">Play or import a MIDI phrase, '
                    "then open the graph again.</text>"
                ),
                "</svg>",
            ]
        )

    def render_constraint_graph_svg(
        self,
        *,
        trace: list[GenerationTraceStep] | None,
        constraints: GenerationConstraintsStatus | None,
        request_id: str | None = None,
        created_at: str | None = None,
        max_steps: int = 96,
    ) -> str:
        max_steps = max(1, min(240, int(max_steps)))
        return self._render_constraint_graph_svg(
            trace=trace or [],
            constraints=constraints,
            request_id=request_id,
            created_at=created_at,
            max_steps=max_steps,
        )

    def _render_constraint_graph_svg(
        self,
        *,
        trace: list[GenerationTraceStep],
        constraints: GenerationConstraintsStatus | None,
        request_id: str | None,
        created_at: str | None,
        max_steps: int,
    ) -> str:
        width = 1080
        shown_trace = trace[:max_steps]
        columns = 5
        node_width = 172
        node_height = 104
        left_margin = 58
        top_margin = 174
        column_gap = 32
        row_gap = 58
        row_count = max(1, (len(shown_trace) + columns - 1) // columns)
        height = max(560, top_margin + row_count * (node_height + row_gap) + 76)
        context = [
            f"request {request_id[:8]}" if request_id else "no request id",
            created_at or "not generated yet",
            f"{len(trace)} trace step{'s' if len(trace) != 1 else ''}",
        ]
        if len(shown_trace) < len(trace):
            context.append(f"showing first {len(shown_trace)}")

        svg_parts = [
            '<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
            'role="img" aria-labelledby="title desc">',
            '<title id="title">Continuator constrained generation graph</title>',
            (
                '<desc id="desc">A static graph snapshot of the latest constrained '
                "generation trace.</desc>"
            ),
            "<style>",
            "svg{background:#071217;color:#ecf4ef;font-family:Avenir Next,Segoe UI,Trebuchet MS,sans-serif}",
            ".title{fill:#ecf4ef;font-size:28px;font-weight:750}",
            ".meta{fill:#9bb8b1;font-size:13px}",
            ".badge{fill:#12262d;stroke:#ffffff;stroke-opacity:.14;stroke-width:1}",
            ".badge-text{fill:#ecf4ef;font-size:12px;font-weight:800}",
            ".node{fill:#10252d;stroke:#f4a261;stroke-opacity:.76;stroke-width:1.3;filter:url(#shadow)}",
            ".node-subtle{fill:#9bb8b1;font-size:10px}",
            ".node-label{fill:#ecf4ef;font-size:12px;font-weight:800}",
            ".node-detail{fill:#f7d3b9;font-size:10px;font-weight:700}",
            ".edge{fill:none;stroke:#f4a261;stroke-opacity:.58;stroke-width:2.2}",
            ".empty-title{fill:#ecf4ef;font-size:22px;font-weight:800}",
            ".empty-copy{fill:#9bb8b1;font-size:14px}",
            ".footer{fill:#9bb8b1;font-size:12px}",
            "</style>",
            "<defs>",
            (
                '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">'
                '<feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#000" flood-opacity=".28"/>'
                "</filter>"
            ),
            (
                '<marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" '
                'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
                '<path d="M 0 0 L 10 5 L 0 10 z" fill="#f4a261" fill-opacity=".86"/>'
                "</marker>"
            ),
            "</defs>",
            '<rect x="0" y="0" width="100%" height="100%" fill="#071217"/>',
            (
                '<rect x="24" y="24" width="1032" height="112" rx="18" '
                'fill="#ffffff" fill-opacity=".035" stroke="#ffffff" stroke-opacity=".08"/>'
            ),
            '<text class="title" x="52" y="58">Last Constraint Graph</text>',
            f'<text class="meta" x="52" y="82">{escape(" - ".join(context))}</text>',
        ]

        badge_data = [
            ("Start", constraints.start if constraints else None),
            ("End", constraints.end if constraints else None),
        ]
        for index, (label, state) in enumerate(badge_data):
            x = 52 + index * 240
            y = 100
            value = _constraint_state_label(state)
            if state and state.value:
                value = f"{value}: {self._truncate_graph_label(str(state.value), 22)}"
            svg_parts.append(
                f'<rect class="badge" x="{x}" y="{y}" width="218" height="24" rx="12"/>'
            )
            svg_parts.append(
                f'<text class="badge-text" x="{x + 12}" y="{y + 16}">'
                f"{escape(f'{label} {value}')}</text>"
            )

        if not shown_trace:
            svg_parts.extend(
                [
                    (
                        '<rect x="80" y="190" width="920" height="250" rx="28" '
                        'fill="#ffffff" fill-opacity=".04" stroke="#ffffff" stroke-opacity=".1"/>'
                    ),
                    '<text class="empty-title" x="120" y="260">No constrained generation trace yet.</text>',
                    (
                        '<text class="empty-copy" x="120" y="292">Generate from memory or send a phrase, '
                        "then open this tab again.</text>"
                    ),
                    (
                        '<text class="empty-copy" x="120" y="322">This view is kept separate from the '
                        "learned memory graph because it is tied to one generation request.</text>"
                    ),
                    "</svg>",
                ]
            )
            return "\n".join(svg_parts)

        positions: list[tuple[float, float]] = []
        for index, _step in enumerate(shown_trace):
            column = index % columns
            row = index // columns
            if row % 2 == 0:
                column_index = column
            else:
                column_index = columns - 1 - column
            x = left_margin + column_index * (node_width + column_gap)
            y = top_margin + row * (node_height + row_gap)
            positions.append((x, y))

        for index in range(1, len(positions)):
            source_x, source_y = positions[index - 1]
            target_x, target_y = positions[index]
            sx = source_x + node_width / 2
            sy = source_y + node_height
            tx = target_x + node_width / 2
            ty = target_y
            if abs(source_y - target_y) < 1:
                sx = source_x + (node_width if target_x > source_x else 0)
                sy = source_y + node_height / 2
                tx = target_x + (0 if target_x > source_x else node_width)
                ty = target_y + node_height / 2
            curve = max(40, abs(tx - sx) * 0.28 + abs(ty - sy) * 0.18)
            path = (
                f"M {sx:.1f} {sy:.1f} C {sx:.1f} {sy + curve:.1f}, "
                f"{tx:.1f} {ty - curve:.1f}, {tx:.1f} {ty:.1f}"
            )
            if abs(source_y - target_y) < 1:
                path = (
                    f"M {sx:.1f} {sy:.1f} C {(sx + tx) / 2:.1f} {sy:.1f}, "
                    f"{(sx + tx) / 2:.1f} {ty:.1f}, {tx:.1f} {ty:.1f}"
                )
            svg_parts.append(
                f'<path class="edge" d="{path}" marker-end="url(#arrow)"/>'
            )

        for index, step in enumerate(shown_trace):
            x, y = positions[index]
            symbol_label = self._truncate_graph_label(
                self._trace_symbol_label(step.symbol),
                24,
            )
            policy = step.policy or "generation"
            candidates = ", ".join(
                f"k{order}:{count}"
                for order, count in zip(step.candidate_orders, step.candidate_counts)
            )
            if not candidates:
                candidates = f"k{step.order}"
            context_label = " / ".join(
                self._truncate_graph_label(self._trace_symbol_label(value), 10)
                for value in step.context[-3:]
            )
            if not context_label:
                context_label = "free start" if step.order == 0 else "empty"

            svg_parts.append(
                f'<rect class="node" x="{x:.1f}" y="{y:.1f}" width="{node_width}" '
                f'height="{node_height}" rx="16"/>'
            )
            svg_parts.append(
                f'<text class="node-subtle" x="{x + 12:.1f}" y="{y + 18:.1f}">'
                f"{escape(f'position {step.position} - order {step.order}')}</text>"
            )
            svg_parts.append(
                _svg_text_lines(
                    self._wrap_graph_label(symbol_label, limit=22, max_lines=2),
                    x=x + 12,
                    y=y + 42,
                    class_name="node-label",
                    line_height=14,
                )
            )
            svg_parts.append(
                f'<text class="node-detail" x="{x + 12:.1f}" y="{y + 76:.1f}">'
                f"{escape(self._truncate_graph_label(policy, 24))}</text>"
            )
            svg_parts.append(
                f'<text class="node-subtle" x="{x + 12:.1f}" y="{y + 94:.1f}">'
                f"{escape(self._truncate_graph_label(candidates, 28))}</text>"
            )
            svg_parts.append(f"<title>{escape(f'context: {context_label}')}</title>")

        footer_copy = (
            "Trace path after compiling/gating the generation constraints. "
            "This is distinct from the learned memory graph."
        )
        svg_parts.append(
            f'<text class="footer" x="52" y="{height - 34}">'
            f"{escape(footer_copy)}</text>"
        )
        svg_parts.append("</svg>")
        return "\n".join(svg_parts)
