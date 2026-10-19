from __future__ import annotations

from app.continuator_adapter import ContinuatorSessionEngine
from .helpers import create_session, learn


def test_graph_snapshot_does_not_depend_on_live_engine(phrase):
    from app.graph_renderer import GraphRenderer

    engine = ContinuatorSessionEngine()
    engine.learn_phrase_events(phrase)
    snapshot = engine.graph_snapshot()
    engine.reset()
    svg = GraphRenderer(snapshot).render_graph_svg()
    assert "1 learned phrase" in svg
    assert "No transitions learned yet" not in svg
    assert "No transitions learned yet" in engine.render_graph_svg()


def test_legacy_graph_route_uses_concrete_defaults(api, phrase):
    client, _ = api
    session_id = create_session(client)
    learn(client, session_id, phrase)
    response = client.get(f"/api/sessions/{session_id}/graph.svg")
    assert response.status_code == 200 and "<svg" in response.text
