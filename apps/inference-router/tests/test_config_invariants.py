"""Caractérisation invariants subtils de parse_model_backends.

test_config.py couvre 6 happy paths (simple URL → llama-cpp default,
multi-backends même prio, provider+env, priority via |prio, empty URL
rejected, invalid priority avec contexte). Ce fichier verrouille les
invariants plus fins du parseur.

  - **Multi-model via `;`** : la chaîne `m1=...;m2=...` produit 2 entrées
    de dict, indépendantes. Si on cassait le split sur `;`, on aurait
    un seul "modèle" avec un nom corrompu.

  - **HTTP/HTTPS NE SONT PAS des providers** : `http://x` est parsé avec
    provider=llama-cpp et url=http://x. Si on enlevait cet exception, on
    aurait provider=http et url=//x, ce qui casse TOUT.

  - **Whitespace toléré autour des entrées et noms de modèles** :
    `' m = http://x '` doit produire le modèle 'm'. Critique pour les
    chaînes éditées à la main dans docker-compose env files.

  - **Entrées vides skippées entre `;`** : `m1=x;;m2=y` doit produire
    2 modèles. Permet de séparer visuellement les entrées dans une
    longue chaîne sans casser le parsing.

  - **URLs vides skippées entre `,`** : `m=http://a,,http://b` doit
    donner 2 backends. Même motif.

  - **Manque le `=` → ValueError avec contexte** : `'invalid_entry'`
    doit raise avec un message contenant l'entrée fautive (pour debug
    rapide des typos dans env vars).

  - **Backends tous vides après filtrage → ValueError** : `m=,,` (après
    le filtre `if u.strip()`) reste 0 backend → la branche `if not
    backends: raise` se déclenche. Le message DOIT mentionner le nom
    du modèle.

  - **Options multiples concaténables** : `http://api|env:X|prio:2`
    doit positionner les deux options simultanément. L'ordre ne
    compte pas.

  - **Option inconnue → ValueError avec nom de l'option** : `|foo:bar`
    doit raise — sinon une typo `|prioo:1` produit silencieusement
    priority=0 (default).

  - **Priorité négative acceptée** : `|prio:-5` est valide. Permet de
    "promouvoir" un backend au-dessus du défaut sans renuméroter les
    autres.

  - **Spec vide → dict vide** : `''` retourne {} sans raise. Permet
    de démarrer le service sans modèles configurés (mode discovery).
"""

from __future__ import annotations

import pytest

from inference_router.config import parse_model_backends


class TestMultiModelSeparator:
    """Plusieurs modèles via `;`."""

    def test_two_models_via_semicolon(self) -> None:
        out = parse_model_backends('m1=http://a;m2=http://b')
        assert set(out.keys()) == {'m1', 'm2'}
        assert out['m1'][0].url == 'http://a'
        assert out['m2'][0].url == 'http://b'

    def test_three_models_with_mixed_priorities(self) -> None:
        spec = 'm1=http://a;m2=http://b|prio:1;m3=http://c'
        out = parse_model_backends(spec)
        assert set(out.keys()) == {'m1', 'm2', 'm3'}
        assert out['m2'][0].priority == 1

    def test_empty_entries_between_semicolons_skipped(self) -> None:
        # `;;` ou `; ;` ne créent pas de modèle vide.
        out = parse_model_backends('m1=http://a;;m2=http://b')
        assert set(out.keys()) == {'m1', 'm2'}

    def test_trailing_semicolon_skipped(self) -> None:
        out = parse_model_backends('m1=http://a;')
        assert set(out.keys()) == {'m1'}


class TestHttpProviderExemption:
    """`http://` et `https://` ne sont PAS interprétés comme provider."""

    def test_http_url_keeps_full_url_and_default_provider(self) -> None:
        # Cas critique : si on traitait `http` comme provider, on aurait
        # provider='http' et url='//x:8080'. Le client ferait des
        # requêtes sur une URL sans scheme = boom.
        out = parse_model_backends('m=http://x:8080')
        assert out['m'][0].provider == 'llama-cpp'
        assert out['m'][0].url == 'http://x:8080'

    def test_https_url_keeps_full_url_and_default_provider(self) -> None:
        out = parse_model_backends('m=https://api.example.com')
        assert out['m'][0].provider == 'llama-cpp'
        assert out['m'][0].url == 'https://api.example.com'

    def test_provider_prefix_can_carry_https_url(self) -> None:
        # `mistral:https://...` — le provider est mistral, l'URL conserve https.
        out = parse_model_backends('m=mistral:https://api.mistral.ai')
        assert out['m'][0].provider == 'mistral'
        assert out['m'][0].url == 'https://api.mistral.ai'


class TestWhitespaceTolerance:
    """Whitespace toléré autour des entrées et noms."""

    def test_whitespace_around_model_name_stripped(self) -> None:
        # Critique : env var multi-ligne formatée à la main.
        out = parse_model_backends('  m  =http://x  ')
        assert 'm' in out
        assert 'm ' not in out
        assert ' m' not in out

    def test_whitespace_only_entries_skipped(self) -> None:
        out = parse_model_backends('   ;m=http://x;   ')
        assert set(out.keys()) == {'m'}


class TestUrlCommaSeparator:
    """URLs séparées par `,` à l'intérieur d'un modèle."""

    def test_empty_url_between_commas_skipped(self) -> None:
        # `,,` filtré par `if u.strip()`.
        out = parse_model_backends('m=http://a,,http://b')
        assert len(out['m']) == 2

    def test_trailing_comma_skipped(self) -> None:
        out = parse_model_backends('m=http://a,')
        assert len(out['m']) == 1


class TestMissingEquals:
    """Entrée sans `=` → ValueError avec contexte."""

    def test_missing_equals_raises(self) -> None:
        with pytest.raises(ValueError, match='invalid MODEL_BACKENDS entry'):
            parse_model_backends('invalid_entry_no_equals')

    def test_missing_equals_message_includes_offending_entry(self) -> None:
        # Le message contient l'entrée fautive pour debug.
        with pytest.raises(ValueError) as exc_info:
            parse_model_backends('m1=http://x;bad_entry')
        assert 'bad_entry' in str(exc_info.value)


class TestEmptyBackendsListRejected:
    """Modèle déclaré sans backend valide → ValueError."""

    def test_all_empty_urls_raises(self) -> None:
        # `m=,,` après filter `if u.strip()` → 0 backends.
        with pytest.raises(ValueError, match='no backends for model'):
            parse_model_backends('m=,,')

    def test_only_whitespace_urls_raises(self) -> None:
        with pytest.raises(ValueError, match='no backends for model'):
            parse_model_backends('m=  ,  ')

    def test_empty_backends_message_includes_model_name(self) -> None:
        with pytest.raises(ValueError) as exc_info:
            parse_model_backends('special_model=,')
        assert 'special_model' in str(exc_info.value)


class TestMultipleOptions:
    """Plusieurs options sur le même backend, indépendantes."""

    def test_env_and_prio_combined(self) -> None:
        out = parse_model_backends('m=https://api|env:KEY|prio:2')
        backend = out['m'][0]
        assert backend.api_key_env == 'KEY'
        assert backend.priority == 2

    def test_option_order_does_not_matter(self) -> None:
        spec1 = 'm=https://api|env:KEY|prio:2'
        spec2 = 'm=https://api|prio:2|env:KEY'
        a = parse_model_backends(spec1)['m'][0]
        b = parse_model_backends(spec2)['m'][0]
        assert a == b


class TestUnknownOptionRejected:
    """Option inconnue → ValueError (anti-typo silencieuse)."""

    def test_unknown_option_raises(self) -> None:
        # Sans ce check, `|prioo:1` (typo) passerait silencieusement
        # et priority resterait au défaut 0 → bug subtil en prod.
        with pytest.raises(ValueError, match='unknown backend option'):
            parse_model_backends('m=http://x|prioo:1')

    def test_unknown_option_message_includes_option(self) -> None:
        with pytest.raises(ValueError) as exc_info:
            parse_model_backends('m=http://x|weird:opt')
        assert 'weird' in str(exc_info.value)


class TestNegativePriority:
    """`|prio:-5` est valide (int() accepte les négatifs)."""

    def test_negative_priority_parsed(self) -> None:
        out = parse_model_backends('m=http://x|prio:-5')
        assert out['m'][0].priority == -5


class TestEmptySpec:
    """Spec vide → dict vide, pas d'erreur."""

    def test_empty_string_yields_empty_dict(self) -> None:
        # Critique : permet de démarrer sans modèles configurés.
        assert parse_model_backends('') == {}

    def test_whitespace_only_spec_yields_empty_dict(self) -> None:
        # Après strip + split + filter, tout est filtré.
        assert parse_model_backends('   ') == {}


class TestEmptyBackendEntryWithinPipes:
    """Une entrée backend complètement vide (pas même de URL) → ValueError."""

    def test_pipe_only_no_url_raises(self) -> None:
        # `|prio:1` sans URL devant → head='' → no URL → ValueError.
        with pytest.raises(ValueError, match='no URL'):
            parse_model_backends('m=|prio:1')
