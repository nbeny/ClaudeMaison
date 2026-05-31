"""Caractérisation workers.worker — entrypoint Arq.

Arq lit les attributs class-level de WorkerSettings au démarrage du
process pour configurer le pool (fonctions enregistrées, hooks
startup/shutdown, concurrence, connexion Redis). Le module worker.py
n'a aucun test alors qu'il est le point d'entrée du worker en prod.

Régressions silencieuses possibles si ces invariants sautent :

  - functions oubliée ou dédoublée : un job poussé par edge-api ne
    serait pas pickable par le worker (Arq lève une KeyError sur le
    nom de la fonction au moment du dispatch, mais ça n'apparaît
    qu'à l'exécution d'un vrai job — invisible en CI).

  - on_startup non câblé : ctx['http'] n'est pas créé, et
    ingest_document explose au premier KeyError. Mais ça aussi
    n'apparaît qu'en runtime.

  - max_jobs hardcodé : on perd la capacité de tuner la concurrence
    par environnement via WORKER_MAX_JOBS, et l'ops doit redéployer
    pour ajuster.

  - redis_settings construit depuis une URL hardcodée : déploiement
    en staging/prod via REDIS_URL=redis://redis-svc:6379/2 (DB 2 pour
    isoler les jobs) serait silencieusement ignoré et tous les jobs
    écrits/lus en DB 0.
"""

from __future__ import annotations

import importlib
import sys
from typing import Any

import pytest
from arq.connections import RedisSettings

from workers.config import get_settings
from workers.jobs import ingest_document, shutdown, startup
from workers.worker import WorkerSettings, _redis_settings


class TestFunctionsRegistry:
    """`functions` est la liste des handlers que Arq enregistre. Toute
    modification de cette liste impacte directement ce que le worker peut
    traiter."""

    def test_functions_contient_exactement_ingest_document(self) -> None:
        # Régression possible : ajout d'une `embed_batch` non testée
        # qui crasherait à l'import, ou suppression de `ingest_document`
        # qui rendrait le worker silencieusement inutile. Lock liste
        # exacte = 1 élément.
        assert len(WorkerSettings.functions) == 1
        assert WorkerSettings.functions[0] is ingest_document

    def test_functions_est_une_liste_pas_un_tuple_ou_set(self) -> None:
        # Arq attend une `list[Callable]` (cf. arq.worker.Worker.__init__).
        # Un set ne préserverait pas l'ordre (peu probable d'avoir un
        # impact ici, mais on lock par principe contre les substitutions
        # automatiques type "modernize this to a set".
        assert isinstance(WorkerSettings.functions, list)

    def test_functions_référence_la_vraie_fonction_pas_un_wrapper(self) -> None:
        # Si quelqu'un mettait `functions = [lambda **kw: ingest_document(**kw)]`
        # pour ajouter du logging "transparent", Arq enregistrerait sous le
        # nom 'lambda' au lieu de 'ingest_document' → edge-api appelle
        # `enqueue_job('ingest_document', ...)` et reçoit une KeyError.
        # Identité référentielle stricte.
        assert WorkerSettings.functions[0] is ingest_document
        assert WorkerSettings.functions[0].__name__ == 'ingest_document'


class TestLifecycleHooks:
    """on_startup / on_shutdown sont appelés par Arq autour de chaque process
    worker. Doivent pointer sur les coroutines de workers.jobs sans wrapper."""

    def test_on_startup_est_la_coroutine_jobs_startup_par_identité(self) -> None:
        # Pas `on_startup = lambda ctx: startup(ctx)`, ni un wrapper
        # async. Identité référentielle stricte pour qu'Arq propage
        # bien le nom dans ses logs et qu'on n'ait pas un wrapper qui
        # capturerait silencieusement une exception au boot.
        assert WorkerSettings.on_startup is startup

    def test_on_shutdown_est_la_coroutine_jobs_shutdown_par_identité(self) -> None:
        # Idem on_startup. Si on_shutdown était un no-op à cause d'un
        # mauvais import (ex: `on_shutdown = startup` typo), l'httpx
        # client ne serait pas aclose() et on aurait des warnings
        # ResourceWarning en CI + des fd leaks en prod.
        assert WorkerSettings.on_shutdown is shutdown

    def test_on_startup_n_est_PAS_on_shutdown_swap_typo(self) -> None:
        # Lock contre le typo classique où on_startup et on_shutdown
        # sont inversés (les noms se ressemblent à scan rapide).
        assert WorkerSettings.on_startup is not WorkerSettings.on_shutdown


class TestMaxJobsFromSettings:
    """max_jobs DOIT venir de Settings.WORKER_MAX_JOBS, pas d'un littéral."""

    def test_max_jobs_correspond_à_settings_au_moment_de_l_import(self) -> None:
        # WorkerSettings est une classe normale, donc `max_jobs =
        # get_settings().WORKER_MAX_JOBS` est évalué AU CHARGEMENT du
        # module. La valeur visible doit donc être la valeur courante
        # de Settings au moment de l'import.
        assert WorkerSettings.max_jobs == get_settings().WORKER_MAX_JOBS

    def test_max_jobs_est_un_int_pas_un_str_ou_float(self) -> None:
        # Arq fait `range(max_jobs)` interne. Un float ou un str
        # ferait planter le boot avec un TypeError peu parlant.
        assert isinstance(WorkerSettings.max_jobs, int)

    def test_max_jobs_default_workers_est_8(self) -> None:
        # Verrouille le défaut documenté dans config.py (concurrence
        # tunée pour workstation locale + embeddings courts). Si
        # quelqu'un baisse à 1 sans changer WORKER_MAX_JOBS, on perd
        # le throughput Jour-1.
        assert WorkerSettings.max_jobs == 8


class TestRedisSettingsFromDsn:
    """redis_settings DOIT venir de RedisSettings.from_dsn(REDIS_URL), pas
    d'une construction manuelle qui ignorerait la DB ou le password."""

    def test_redis_settings_est_une_instance_RedisSettings(self) -> None:
        # Arq fait isinstance(redis_settings, RedisSettings) interne ;
        # un dict ou un str planterait le boot.
        assert isinstance(WorkerSettings.redis_settings, RedisSettings)

    def test_redis_settings_host_match_localhost_default(self) -> None:
        # Default config.py : REDIS_URL=redis://localhost:6379/0
        # → host='localhost'. Si on hardcodait `host='redis'`, le
        # worker en dev (hors compose) ne se connecterait pas.
        assert WorkerSettings.redis_settings.host == 'localhost'

    def test_redis_settings_port_6379(self) -> None:
        assert WorkerSettings.redis_settings.port == 6379

    def test_redis_settings_database_0(self) -> None:
        # DB 0 est la convention monorepo (edge-api utilise aussi DB 0).
        # Si on default à `database=None`, redis renvoie DB 0 implicite,
        # mais on lock le comportement explicite pour qu'un changement
        # de REDIS_URL=...//2 soit honoré.
        assert WorkerSettings.redis_settings.database == 0


class TestRedisSettingsHonorsCustomDsn:
    """Le helper _redis_settings() doit appeler RedisSettings.from_dsn(URL),
    donc si on monkeypatch settings, le résultat doit refléter la nouvelle URL.
    """

    def test_redis_settings_honore_un_dsn_custom_avec_db_2(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Patche directement la fonction get_settings utilisée par le
        # module worker pour retourner une URL custom. _redis_settings()
        # doit refléter cette URL.
        from workers import worker as worker_mod

        class FakeSettings:
            REDIS_URL = 'redis://otherhost:7777/2'
            WORKER_MAX_JOBS = 16

        monkeypatch.setattr(worker_mod, 'get_settings', lambda: FakeSettings())
        rs = worker_mod._redis_settings()
        assert rs.host == 'otherhost'
        assert rs.port == 7777
        assert rs.database == 2

    def test_redis_settings_honore_user_password_dans_dsn(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # En prod, REDIS_URL peut être redis://user:secret@redis:6379/0
        # via le service mesh. La fonction doit propager username/password.
        from workers import worker as worker_mod

        class FakeSettings:
            REDIS_URL = 'redis://alice:s3cret@redis-svc:6379/0'
            WORKER_MAX_JOBS = 8

        monkeypatch.setattr(worker_mod, 'get_settings', lambda: FakeSettings())
        rs = worker_mod._redis_settings()
        assert rs.username == 'alice'
        assert rs.password == 's3cret'
        assert rs.host == 'redis-svc'


class TestClassLevelEvaluation:
    """max_jobs et redis_settings sont évalués au moment de la définition
    de la classe (pas à chaque accès). On verrouille cette propriété."""

    def test_max_jobs_est_un_attribut_de_classe_pas_un_property(self) -> None:
        # Si quelqu'un transformait `max_jobs` en property() qui appelle
        # get_settings() à chaque accès, on dégraderait perf au boot
        # (Arq inspecte tous les attrs) et on perdrait l'invariant
        # "valeur figée au boot du process".
        # vars(cls) ne contient pas les properties ; `'max_jobs' in vars`
        # garantit que c'est un attribut data.
        assert 'max_jobs' in vars(WorkerSettings)
        assert not isinstance(vars(WorkerSettings)['max_jobs'], property)

    def test_redis_settings_est_un_attribut_de_classe_pas_un_property(self) -> None:
        assert 'redis_settings' in vars(WorkerSettings)
        assert not isinstance(vars(WorkerSettings)['redis_settings'], property)

    def test_functions_est_attribut_de_classe(self) -> None:
        assert 'functions' in vars(WorkerSettings)
        assert isinstance(vars(WorkerSettings)['functions'], list)


class TestModuleImportStability:
    """Le module doit s'importer sans crash même si Settings tombe sur ses
    défauts (env vide). Garantit qu'un dev clonant le repo peut lancer les
    tests sans configurer un .env."""

    def test_module_se_reimporte_sans_erreur(self) -> None:
        # Si une régression ajoutait un `assert SOME_VAR in os.environ` au
        # top-level, le reimport ferait planter en CI. On force une
        # réimportation propre.
        sys.modules.pop('workers.worker', None)
        mod = importlib.import_module('workers.worker')
        assert hasattr(mod, 'WorkerSettings')
        assert hasattr(mod, '_redis_settings')

    def test_redis_settings_helper_est_callable(self) -> None:
        # Sanity : la signature reste invariante (zéro arg → RedisSettings).
        result: Any = _redis_settings()
        assert isinstance(result, RedisSettings)
