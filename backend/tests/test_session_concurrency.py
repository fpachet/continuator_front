from __future__ import annotations

from app.session_manager import SessionManager
from .helpers import create_session, learn, pitch_events


def test_reset_waits_for_complete_generation_operation(api, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from app.schemas import ContinueRequest

    client, main = api
    session_id = create_session(client)
    engine = main.session_manager._sessions[session_id].engine
    entered, release, reset_entered = Event(), Event(), Event()
    original_continue, original_reset = engine.continue_phrase, engine.reset

    def paused_continue(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original_continue(*args, **kwargs)

    def observed_reset():
        reset_entered.set()
        return original_reset()

    monkeypatch.setattr(engine, "continue_phrase", paused_continue)
    monkeypatch.setattr(engine, "reset", observed_reset)
    with ThreadPoolExecutor(max_workers=2) as workers:
        generated = workers.submit(
            main.session_manager.continue_phrase,
            ContinueRequest(
                session_id=session_id,
                phrase=pitch_events([60, 62, 64, 65]),
                continuation_note_count=4,
            ),
            None,
        )
        assert entered.wait(2)
        reset = workers.submit(main.session_manager.reset_session, session_id, None)
        try:
            assert not reset_entered.wait(0.1)
        finally:
            release.set()
        generated.result(timeout=3)
        reset.result(timeout=3)
    assert main.session_manager.get_memory(session_id, None).items == []
    assert main.storage.count_continuation_requests(session_id) == 0
    assert len(main.storage.get_history(session_id)) == 2
    assert SessionManager(main.storage).get_memory(session_id, None).items == []


def test_other_session_can_generate_while_one_is_waiting(api, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from app.schemas import ContinueRequest

    client, main = api
    first, second = create_session(client), create_session(client)
    engine = main.session_manager._sessions[first].engine
    entered, release = Event(), Event()
    original = engine.continue_phrase

    def paused(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)

    monkeypatch.setattr(engine, "continue_phrase", paused)

    def request(session_id):
        return ContinueRequest(
            session_id=session_id,
            phrase=pitch_events([60, 62, 64, 65]),
            continuation_note_count=4,
        )

    with ThreadPoolExecutor(max_workers=2) as workers:
        waiting = workers.submit(
            main.session_manager.continue_phrase, request(first), None
        )
        assert entered.wait(2)
        other = workers.submit(
            main.session_manager.continue_phrase, request(second), None
        )
        try:
            assert other.result(timeout=2).generated_phrase.note_count == 4
        finally:
            release.set()
        waiting.result(timeout=3)


def test_history_readers_never_observe_half_a_request(api, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from app.schemas import ContinueRequest

    client, main = api
    session_id = create_session(client)
    entered, release = Event(), Event()
    original = main.storage.log_phrase

    def paused(**kwargs):
        if kwargs["kind"] == "generated":
            entered.set()
            assert release.wait(3)
        return original(**kwargs)

    monkeypatch.setattr(main.storage, "log_phrase", paused)
    with ThreadPoolExecutor(max_workers=1) as workers:
        pending = workers.submit(
            main.session_manager.continue_phrase,
            ContinueRequest(
                session_id=session_id,
                phrase=pitch_events([60, 62, 64, 65]),
                continuation_note_count=4,
            ),
            None,
        )
        assert entered.wait(2)
        try:
            assert main.storage.get_history(session_id) == []
        finally:
            release.set()
        pending.result(timeout=3)
    assert len(main.storage.get_history(session_id)) == 2


def test_graph_layout_releases_session_lock(api, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from app.graph_renderer import GraphRenderer
    from app.schemas import ContinueRequest

    client, main = api
    session_id = create_session(client)
    learn(client, session_id, pitch_events([60, 62, 64, 65]))
    entered, release = Event(), Event()
    original = GraphRenderer.render_graph_svg

    def paused(renderer, **options):
        entered.set()
        assert release.wait(3)
        return original(renderer, **options)

    monkeypatch.setattr(GraphRenderer, "render_graph_svg", paused)
    with ThreadPoolExecutor(max_workers=2) as workers:
        graph = workers.submit(
            main.session_manager.render_memory_graph_svg, session_id, None
        )
        assert entered.wait(2)
        generation = workers.submit(
            main.session_manager.continue_phrase,
            ContinueRequest(
                session_id=session_id,
                phrase=pitch_events([60, 62]),
                continuation_note_count=2,
            ),
            None,
        )
        try:
            assert generation.result(timeout=2).generated_phrase.note_count == 2
        finally:
            release.set()
        assert "<svg" in graph.result(timeout=3)
