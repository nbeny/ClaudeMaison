-- Extensions Postgres provisionnées avant tout schéma applicatif.
-- Atlas CE ne sait pas gérer CREATE EXTENSION dans son diff ;
-- on les charge ici, à l'initdb du conteneur de dev.
-- En prod, le DBA / l'opérateur cluster est responsable du provisioning.
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
