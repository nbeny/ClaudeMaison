// Config Atlas pour le diff schema déclaratif → migrations versionnées.
//
// Usage local :
//   atlas migrate diff <nom> --env local
//   atlas migrate apply --env local
//
// La source de vérité est `infrastructure/db/schema.sql`. Les migrations
// générées vivent dans `infrastructure/db/migrations/`. On les commit, on ne
// les édite pas à la main (sauf pour décomposer un changement destructeur en
// expand/contract).

env "local" {
  src = "file://infrastructure/db/schema.sql"
  dev = "docker://postgres/17/dev?search_path=public"
  url = getenv("DATABASE_URL")

  migration {
    dir = "file://infrastructure/db/migrations"
  }

  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}
