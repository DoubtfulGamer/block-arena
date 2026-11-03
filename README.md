# Block Arena

Krunker-style blocky multiplayer FPS. Runs in the browser. All art is SVG, all sound is generated.

## Run
1. Install Node.js (https://nodejs.org), version 18 or newer.
2. Double-click `start.bat` (Windows) or run `./start.sh` (Linux/Mac).
3. The window prints the addresses. Open `http://localhost:8080` yourself.
   Friends on the same Wi-Fi open `http://YOUR_IP:8080` and press JOIN.

## Game modes (8)
| Mode | How it works |
|---|---|
| Free For All | Everyone for themselves. First to 20 kills. |
| Team Deathmatch | Red vs blue. First team to 30 kills. |
| Hardpoint | Stand in the glowing zone: 1 point a second. The zone jumps every 45 s. Contested = nobody scores. First team to 120. |
| Capture The Flag | Grab the enemy flag, carry it to your base. Your own flag must be home to score. Drop it when you die. First to 3 captures. |
| Kill Confirmed | Kills drop dog tags. Collect enemy tags to score, collect your side's tags to deny them. First to 40. |
| Gun Game | Every kill gives the next gun (pistol, revolver, SMG, shotgun, rifle, LMG, marksman, sniper). A kill with the last gun wins. |
| Infected | One player starts infected (claws, 150 hp, fast). Survivors who die join the infected. Survivors win when the 4 minute timer ends. |
| Last Man Standing | One life per round. Last player alive wins the round. First to 3 round wins. |

Every mode also has a time limit. By default all modes take turns, one match each.

## Choosing the mode (host)
The host is the player on the same PC that runs the server. Friends cannot change settings.
- In the menu (before you join): HOST CONTROLS lets you pick the game mode, map, score limit and time limit.
- In game: press Esc, the same HOST CONTROLS are at the top of the pause menu.
- SAVE FOR NEXT MATCH keeps the choice for when the current match ends. START NOW restarts immediately.
- Pick a single mode to play only that mode, or "All modes take turns". Same for the map.
- If nobody is on the server PC, the first player to join is the host. The player on the server PC takes over when they join.
- Command line: `start.bat ctf` (any of rotate ffa tdm hp ctf kc gg inf lms). `set LIMIT=10` and `set TIME=300` set limits.

## Windows firewall (once, as admin)
    netsh advfirewall firewall add rule name="BlockArena" dir=in action=allow protocol=TCP localport=8080

Other port: `set PORT=9000` before starting.
Lock one map (otherwise maps rotate after every match): `set MAP=Fortress` (or a number 1-5).

## Maps (rotate every match)
1 Arena, 2 Warehouse (indoor, catwalks), 3 Fortress (team bases + bridge), 4 Canyon (sunset), 5 Skyblocks (night).
In team mode, Fortress spawns each team in its own base.

## Classes (pick in the menu, or press 1-6 while dead)
1 Assault (rifle + pistol), 2 Rusher (SMG + pistol, fast), 3 Hunter (sniper + revolver),
4 Breacher (shotgun + revolver), 5 Gunner (LMG + pistol, slow), 6 Marksman (semi-auto + revolver).

## Controls (all keys can be changed in Settings)
WASD move, Space jump (hold it to bunny hop), Shift or C crouch (run, then crouch to SLIDE), mouse aim,
left click fire, right click aim/scope, R reload, 1 / 2 / mouse wheel switch weapon, Enter chat,
Tab scores, Esc pause menu (settings, resume, leave).

Movement feel: air control, jump buffering (press jump just before landing), coyote time (jump just after
leaving a ledge), steer while sliding, automatic stair stepping. Mouse: raw input (no OS acceleration),
separate aim sensitivity, invert Y, crouch and aim can be hold or toggle.

## Graphics options (Settings, also reachable in game from the pause menu)
Preset Low / Medium / High, render scale 50-150%, shadows (off, simple blob shadows, full sun shadows
that players cast too), view distance, textures, block outlines, ambient shading, anti-aliasing
(needs a page reload), FPS counter, gun bob and sway.
Frame rate limit (default 60; menus and the pause screen never go above 30) and a Battery saver preset
(30 FPS, 75% scale, no shadows) keep a laptop cool. Medium is the default. High turns on full shadows and needs a decent GPU; if the GPU is too weak the game
falls back to simple shadows by itself.

## Damage
Headshots do 1.5x damage. Damage drops with distance. Sniper: 80 on the body (120 on the head, still one shot).
Health regenerates after 5 seconds without being hit.

## Settings file (one file for everybody)
The server saves its settings in `settings.json` next to `server.js` (created on the first run, updated whenever the
host changes something in the menu). It applies to every player and is loaded again when the server restarts.
It holds:
- `headshotMultiplier` (default 1.5) and `maxPlayers` (2-32, default 12)
- `weapons`: damage, rate, mag, reload and spread of every weapon (edit these to rebalance the game)
- `host`: game mode, map, score limit and time limit the host picked
- `whitelist`: on/off and the list of allowed addresses

Edit it while the server is stopped. A broken file is ignored, silly values are ignored, a mode or map given on the
command line wins over the file. Move it with `set SETTINGS=C:\path\settings.json`. `set SETTINGS=off` turns saving off.
Your own browser settings (sensitivity, keys, graphics) stay in each player's browser.

## IP whitelist
Only the host sees this: HOST CONTROLS, then IP WHITELIST, in the menu or the pause menu.
- Tick "Only allow listed IPs". Then only listed addresses (and the PC running the server) can open the game page or join.
- Add an address like `192.168.1.25` or a whole range like `192.168.1.0/24`.
- The list also shows everybody connected with their IP and an Allow button.
- Switching it on automatically allows everybody connected at that moment, so nobody is thrown out.
- Removing an address disconnects that player. The server PC can never be locked out.
- The whitelist is saved in `settings.json` and survives restarts.

## Laptop gets hot or shuts down?
The server itself is very light (about 0.5% of one CPU core idle, about 3% with 12 players). The heat comes from
the game running in the browser, because it draws as many frames as the screen allows.
- Settings, Graphics: set Preset to Battery saver, or at least Frame rate limit to 30 or 60.
- Turn on "Show FPS" to see what the game is doing. Keep the laptop plugged in, on a hard surface, vents clear.
- To test the server alone: start it and do not open the game on that laptop. If the laptop still shuts off,
  the cause is the laptop (cooling, battery, power or drivers), not this program.
- Windows: Event Viewer, Windows Logs, System, look for "Kernel-Power" event 41 around the shutdown time.

## Files
- server.js         game server + web server (needs only the `ws` package, already in node_modules)
- public/index.html game client (raw WebGL, no 3D library)
