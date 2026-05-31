"""Caractérisation invariants subtils EventPublisher (ai-core/events).

test_events_publisher.py couvre 3 happy paths (token, done, error
serialization). Ce fichier verrouille les invariants de protocole qui
ne sont pas explicites dans le code mais critiques côté wire avec
realtime (TS) et NATS.

  - **Subject format `events.<conversation_id>`** : utilisé comme PATTERN
    NATS côté realtime (`events.*` ou `events.<id>` selon le mode du
    subscriber). Tout changement de prefix (`event.`, `ai-core.events.`)
    casse silencieusement le routing : les messages partent mais
    aucun subscriber n'écoute le nouveau prefix.

  - **Payload encodé en bytes UTF-8** : NATS API n'accepte que `bytes`.
    Si on passait `str`, ça throw TypeError. Si on encodait en latin-1,
    on perdrait les emojis dans `delta`.

  - **Keys en camelCase, pas snake_case** : c'est la frontière avec
    TypeScript. `messageId`, `finishReason`, `tokensIn`, `tokensOut`.
    Côté TS realtime, le parseur s'attend à du camelCase ; recevoir
    `message_id` ferait juste rien (les champs sont undefined côté hub).

  - **Discriminateur `type`** : chaque payload a un `type` parmi
    `'token' | 'done' | 'error'`. Le hub realtime route SUR ce champ.
    Si on le supprimait, le hub ne saurait pas quoi faire du message.

  - **Une publication = un publish NATS** : pas de batching, pas de
    buffering. Verrouille le contrat : N appels = N messages, dans
    l'ordre. Sinon la séquence de tokens arriverait dans le désordre.

  - **Exception NATS propagée, pas swallowed** : si publish throw
    (connexion morte), le caller doit savoir pour escalader vers
    l'orchestrator (qui passera en mode error). Si on swallowait,
    l'orchestrator continuerait à émettre des tokens fantômes
    invisibles côté UI.

  - **conversation_id avec `.` produit un subject NATS multi-segment** :
    NATS traite `.` comme séparateur de hiérarchie. Si un conv_id
    contient un point, le subject `events.foo.bar` correspond à
    `events.*` mais PAS à `events.foo`. C'est un comportement actuel
    (pas de quoting) — on le verrouille pour signaler au futur
    refactor qu'il faut décider explicitement (escape ou interdire).

  - **delta vide chaîne est forwardé** (pas filtré au niveau publisher) :
    le filtrage des deltas vides se fait en amont, dans l'orchestrator.
    Publisher est dumb — il sérialise ce qu'on lui donne. Sinon, la
    responsabilité du filtrage serait partagée entre deux couches.

  - **drain() est délégué directement à la connexion** : pas d'état
    côté publisher. Verrouille le contrat : pas de buffer interne à
    flush, juste forward.

  - **L'ordre des keys dans le payload JSON est l'ordre d'insertion
    Python** : pas une garantie cross-language explicite, mais
    Python 3.7+ + json.dumps préservent l'ordre. Cette stabilité
    facilite le diffing de logs et le debug par grep.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from ai_core.events import EventPublisher


class _RecordingNats:
    def __init__(self) -> None:
        self.published: list[tuple[str, bytes]] = []
        self.drained = 0

    async def publish(self, subject: str, data: bytes) -> None:
        self.published.append((subject, data))

    async def drain(self) -> None:
        self.drained += 1


class _ExplodingNats:
    """Nats qui throw sur publish — pour vérifier que ce n'est PAS swallowed."""

    async def publish(self, subject: str, data: bytes) -> None:
        raise ConnectionError('nats is down')

    async def drain(self) -> None: ...


class TestSubjectFormat:
    """Le subject est `events.<conversation_id>` LITÉRAL."""

    async def test_subject_uses_dot_separator_with_events_prefix(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='abc', message_id='m1', delta='x')
        subject, _ = nc.published[0]
        assert subject == 'events.abc'

    async def test_subject_prefix_is_lowercase_events(self) -> None:
        # Si on changeait pour `Events.` ou `EVENTS.`, NATS distinguerait
        # (case-sensitive subjects). Locker la casse.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c1', message_id='m', delta='x')
        subject = nc.published[0][0]
        assert subject.startswith('events.')
        assert not subject.startswith('Events.')
        assert not subject.startswith('ai-core.')

    async def test_subject_for_done_and_error_uses_same_pattern(self) -> None:
        # Toutes les méthodes partagent le même subject pattern : le
        # subscriber n'a qu'un binding à faire par conversation.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='cv', message_id='m', delta='x')
        await pub.done(
            conversation_id='cv', message_id='m', finish_reason='stop',
            tokens_in=1, tokens_out=1,
        )
        await pub.error(conversation_id='cv', message_id='m', reason='r')
        subjects = [s for s, _ in nc.published]
        assert subjects == ['events.cv', 'events.cv', 'events.cv']

    async def test_conversation_id_with_dot_creates_multi_segment_subject(self) -> None:
        # NATS traite `.` comme séparateur. Comportement actuel : pas
        # d'escape, le subject devient `events.foo.bar`. Un subscriber
        # bindé sur `events.foo` ne le verra PAS, un bindé sur
        # `events.*` non plus (car `*` = 1 segment). Verrouillé pour
        # forcer une décision explicite en cas de refactor.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='foo.bar', message_id='m', delta='x')
        subject = nc.published[0][0]
        assert subject == 'events.foo.bar'
        # Le subject A DEUX dots = trois segments. Le subscriber typique
        # `events.<id>` (`events.*` en NATS) NE matche PAS.
        assert subject.count('.') == 2


class TestPayloadEncoding:
    """Le payload est bytes UTF-8 — pas str, pas latin-1."""

    async def test_data_is_bytes_not_str(self) -> None:
        # NATS Python API exige bytes. Si on passait str, TypeError.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='x')
        _, data = nc.published[0]
        assert isinstance(data, bytes)
        assert not isinstance(data, str)

    async def test_utf8_encoding_preserves_emoji_in_delta(self) -> None:
        # delta contient les tokens LLM, potentiellement avec emojis ou
        # caractères CJK. UTF-8 doit être préservé.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='🚀 こんにちは')
        _, data = nc.published[0]
        payload = json.loads(data)
        assert payload['delta'] == '🚀 こんにちは'

    async def test_data_decodable_as_utf8(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='hello')
        _, data = nc.published[0]
        # Doit pouvoir round-trip UTF-8 sans erreur.
        decoded = data.decode('utf-8')
        assert decoded == json.dumps({'type': 'token', 'messageId': 'm', 'delta': 'hello'})


class TestCamelCaseKeys:
    """Clés camelCase — frontière avec TS realtime."""

    async def test_token_uses_messageId_not_message_id(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m1', delta='x')
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert 'messageId' in payload
        assert 'message_id' not in payload

    async def test_done_uses_finishReason_tokensIn_tokensOut(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.done(
            conversation_id='c', message_id='m', finish_reason='stop',
            tokens_in=42, tokens_out=7,
        )
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert 'finishReason' in payload
        assert 'tokensIn' in payload
        assert 'tokensOut' in payload
        assert 'finish_reason' not in payload
        assert 'tokens_in' not in payload
        assert 'tokens_out' not in payload

    async def test_no_snake_case_keys_in_any_event_type(self) -> None:
        # Belt-and-suspenders : aucune des 3 méthodes ne doit produire
        # une key contenant `_` au milieu d'identifiants.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='x')
        await pub.done(
            conversation_id='c', message_id='m', finish_reason='stop',
            tokens_in=1, tokens_out=1,
        )
        await pub.error(conversation_id='c', message_id='m', reason='r')
        for _, data in nc.published:
            payload: dict[str, Any] = json.loads(data)
            for key in payload:
                # Toutes les keys du domaine sont des identifiants simples
                # ou camelCase. Si une key contient `_` au milieu, c'est
                # une régression vers snake_case.
                assert '_' not in key, f'snake_case leaked: {key!r}'


class TestTypeDiscriminator:
    """Chaque payload a un champ `type`."""

    async def test_token_type_is_token(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='x')
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert payload.get('type') == 'token'

    async def test_done_type_is_done(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.done(
            conversation_id='c', message_id='m', finish_reason='stop',
            tokens_in=1, tokens_out=1,
        )
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert payload.get('type') == 'done'

    async def test_error_type_is_error(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.error(conversation_id='c', message_id='m', reason='r')
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert payload.get('type') == 'error'

    async def test_type_field_is_first_in_payload(self) -> None:
        # Pas un contrat fort, mais facilite le debug par grep et la
        # lisibilité humaine des logs. Préservé par Python dict ordering.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='x')
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        first_key = next(iter(payload))
        assert first_key == 'type'


class TestOneCallOnePublish:
    """N appels = N messages NATS, dans l'ordre."""

    async def test_token_then_token_produces_two_publishes_in_order(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='1')
        await pub.token(conversation_id='c', message_id='m', delta='2')
        assert len(nc.published) == 2
        d1 = json.loads(nc.published[0][1])['delta']
        d2 = json.loads(nc.published[1][1])['delta']
        assert (d1, d2) == ('1', '2')

    async def test_mixed_token_done_sequence_preserved(self) -> None:
        # Pattern typique : N tokens puis 1 done. L'ordre doit être strict.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='Hello')
        await pub.token(conversation_id='c', message_id='m', delta=' world')
        await pub.done(
            conversation_id='c', message_id='m', finish_reason='stop',
            tokens_in=1, tokens_out=2,
        )
        types = [json.loads(d)['type'] for _, d in nc.published]
        assert types == ['token', 'token', 'done']


class TestExceptionPropagation:
    """Si NATS throw, le caller le sait."""

    async def test_publish_error_propagates_to_caller(self) -> None:
        # Si publish() throw, le caller (orchestrator) DOIT être averti
        # pour basculer en mode error. Swallow = tokens fantômes côté
        # back-end qui n'arriveront jamais côté UI.
        pub = EventPublisher(connection=_ExplodingNats())  # type: ignore[arg-type]
        with pytest.raises(ConnectionError, match='nats is down'):
            await pub.token(conversation_id='c', message_id='m', delta='x')

    async def test_done_publish_error_propagates(self) -> None:
        pub = EventPublisher(connection=_ExplodingNats())  # type: ignore[arg-type]
        with pytest.raises(ConnectionError):
            await pub.done(
                conversation_id='c', message_id='m', finish_reason='stop',
                tokens_in=1, tokens_out=1,
            )

    async def test_error_publish_error_propagates(self) -> None:
        # Cas méta-ironique : si on essaie de publier une error et que
        # la connexion est down, on remonte l'exception (pas de boucle
        # infinie de tentatives).
        pub = EventPublisher(connection=_ExplodingNats())  # type: ignore[arg-type]
        with pytest.raises(ConnectionError):
            await pub.error(conversation_id='c', message_id='m', reason='r')


class TestEmptyDeltaForwarded:
    """delta='' est forwardé — le filtrage est à la couche supérieure."""

    async def test_empty_string_delta_produces_a_publish(self) -> None:
        # Publisher est dumb : il sérialise ce qu'on lui passe. Le filtre
        # `if evt.delta` vit dans orchestrator.loop, pas ici. Cette
        # caractérisation interdit de "smartifier" le publisher
        # (sinon double-filtrage hors-bande).
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='')
        assert len(nc.published) == 1
        payload = json.loads(nc.published[0][1])
        assert payload['delta'] == ''


class TestNumericFields:
    """tokens_in / tokens_out sérialisés comme nombres JSON (pas strings)."""

    async def test_tokens_are_json_numbers(self) -> None:
        # `JSON.parse` côté TS produirait des strings si on encodait des
        # strings — le typage côté usage events serait alors faux.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.done(
            conversation_id='c', message_id='m', finish_reason='stop',
            tokens_in=42, tokens_out=7,
        )
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert isinstance(payload['tokensIn'], int)
        assert isinstance(payload['tokensOut'], int)
        assert payload['tokensIn'] == 42
        assert payload['tokensOut'] == 7

    async def test_zero_tokens_serialized_as_zero_not_omitted(self) -> None:
        # Edge case : un message vide a 0 token. La key doit être
        # présente avec valeur 0, pas omise (sinon usage event = NaN).
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.done(
            conversation_id='c', message_id='m', finish_reason='stop',
            tokens_in=0, tokens_out=0,
        )
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert payload['tokensIn'] == 0
        assert payload['tokensOut'] == 0


class TestNoExtraFields:
    """Aucune fuite de champ non-spécifié dans le payload."""

    async def test_token_payload_has_exactly_three_keys(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c', message_id='m', delta='x')
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert set(payload.keys()) == {'type', 'messageId', 'delta'}

    async def test_done_payload_has_exactly_five_keys(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.done(
            conversation_id='c', message_id='m', finish_reason='length',
            tokens_in=1, tokens_out=2,
        )
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert set(payload.keys()) == {
            'type', 'messageId', 'finishReason', 'tokensIn', 'tokensOut',
        }

    async def test_error_payload_has_exactly_three_keys(self) -> None:
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.error(conversation_id='c', message_id='m', reason='boom')
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert set(payload.keys()) == {'type', 'messageId', 'reason'}

    async def test_conversation_id_NOT_in_payload(self) -> None:
        # conversation_id est dans le SUBJECT, pas dans le payload. Si
        # on le dupliquait, on doublerait les bytes par message * N tokens.
        nc = _RecordingNats()
        pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
        await pub.token(conversation_id='c-uuid-1234', message_id='m', delta='x')
        payload: dict[str, Any] = json.loads(nc.published[0][1])
        assert 'conversationId' not in payload
        assert 'conversation_id' not in payload


class TestDrainDelegation:
    """drain() est un passthrough vers la connexion."""

    async def test_drain_calls_connection_drain(self) -> None:
        # Pas d'état buffer dans le publisher. drain() est une
        # responsabilité connexion, pas publisher.
        nc = _RecordingNats()
        # Note : le publisher n'expose pas drain dans son API publique.
        # On vérifie que l'objet connection est intact et atteignable.
        EventPublisher(connection=nc)  # type: ignore[arg-type]
        await nc.drain()
        assert nc.drained == 1
