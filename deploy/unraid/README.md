# Running on Unraid (Compose Manager)

The stack (`mc-ai-survivors-minecraft` + `mc-ai-survivors-bots`) shows up in **Docker → Compose**
as `MC_AI_Survivors`. **Compose Up** starts it, **Compose Down** stops it. It is not on autostart.
The LLM is the separate Unraid `ollama` container, so start that first.

## Layout

```
/mnt/dockervolumes/mc-ai-survivors/
  .env          settings (copy of deploy/unraid/.env.example)
  config.yaml   bot config (copy of config.example.yaml; reads models/limits from .env)
  data/         Minecraft server + world
  plugins/      SurvivorsBridge-*.jar, RealisticSeasons-*.jar
  state/ logs/  bot memory and logs
  app/          this repo (build context for the bots image)
/boot/config/plugins/compose.manager/projects/MC_AI_Survivors/
  name  description  indirect (-> app/deploy/unraid)  envpath (-> ../.env)
```

## Install

```bash
D=/mnt/dockervolumes/mc-ai-survivors
mkdir -p $D/{data,plugins,state,logs}
# from the PC: rsync the repo to $D/app (without node_modules, data, state, logs)
cp $D/app/deploy/unraid/.env.example $D/.env      # set RCON_PASSWORD, MC_WHITELIST, MC_OPS
cp $D/app/config.example.yaml $D/config.yaml
cp SurvivorsBridge-*.jar RealisticSeasons-*.jar $D/plugins/
chown -R 1000:100 $D/data $D/state $D/logs
P=/boot/config/plugins/compose.manager/projects/MC_AI_Survivors
mkdir -p $P
echo MC_AI_Survivors > $P/name
echo "LLM survivor bots + Paper server (LAN :25566)" > $P/description
echo $D/app/deploy/unraid > $P/indirect
echo $D/.env > $P/envpath
echo false > $P/autostart
```

Join from the LAN or WireGuard: `laconia:25566` (192.168.2.120:25566) (whitelisted name only).

## Update the code

rsync the repo to `$D/app` again, then in the UI: **Compose Down**, **Update Stack** (rebuilds the
bots image), **Compose Up**.

## Switching Ollama to a GPU

1. In the Unraid `ollama` container (Docker tab → Edit):
   - **NVIDIA**: install the *Nvidia-Driver* plugin, set repository `ollama/ollama:latest`,
     Extra Parameters `--runtime=nvidia`, variable `NVIDIA_VISIBLE_DEVICES=all`.
   - **AMD**: keep `ollama/ollama:rocm`, add devices `/dev/kfd` and `/dev/dri`.
   Check the log says `library=cuda` / `library=rocm` instead of `library=cpu`.
2. `docker exec ollama ollama pull qwen2.5:7b`
3. In `$D/.env` switch to the GPU profile (commented block), then Compose Down + Compose Up.

CPU timings measured on Laconia (2× E5-2683 v4, one 3.6k-token decision): qwen2.5:1.5b 12–20 s,
qwen2.5:3b 20–40 s, qwen3:8b 50–120 s. An RTX 2060 does the same in ~6 s.
