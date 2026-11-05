# Campus Shuttle Tracker

A real-time shuttle tracker for a campus or small public-transport network.

- **Live location** of every shuttle on a map (from the driver's phone GPS or any GPS tracker)
- **Estimated arrival time** at every stop, recalculated every second
- **Seat availability** from an infrared sensor at the bus door (an ESP32 counts people boarding and leaving)

No database, no build step, **no npm packages**. Only Node.js 16+ is needed.

## Run it

```bash
cd campus-shuttle-tracker
node server.js            # or: npm start
```

Open `http://localhost:3000`. The terminal also prints a network address, so phones on the same Wi-Fi can open the site.

By default the server runs a **demo simulation** (three shuttles driving two loops, with passengers boarding), so you see everything working immediately. Real data automatically takes over per bus: once a real GPS fix arrives, that bus stops being simulated.

```bash
SIMULATE=false node server.js              # real data only; buses without signal show "No GPS signal"
DEVICE_KEY=mysecret PORT=8080 node server.js   # require an access key for all data-posting requests
```

(On Windows PowerShell: `$env:SIMULATE="false"; node server.js`)

## Pages

| URL | For |
|---|---|
| `/` | Passengers: map, next shuttles at your stop, ETA, seats free |
| `/driver.html` | Drivers: pick the bus, tap Start to share phone GPS; manual seat count backup |

Browsers only allow GPS on **HTTPS or localhost**. For real drivers, deploy the server behind HTTPS (Render, Railway, Fly.io, a VPS with Caddy/nginx, or a tunnel such as Cloudflare Tunnel or ngrok).

## Set up your own campus

Edit `data/campus.json`:

- `stops`: id, name, latitude, longitude
- `routes`: a loop described by `path`, a list that mixes stop ids and `[lat, lng]` waypoints (waypoints bend the line along real roads). Routes close back to the first stop automatically.
- `buses`: id, name, which route, `capacity` (seats), `startOffset` (0 to 1, only used by the simulator)

Restart the server after editing.

## How the ETA works

1. Each GPS fix is snapped onto the route line, giving the distance travelled along the loop.
2. Distance to a stop = distance ahead along the loop to that stop.
3. ETA = distance / smoothed recent speed (minimum 3 m/s) + 15 seconds for every stop in between.

Buses are tracked on fixed loops, so ETAs stay stable even with noisy GPS. A bus more than 60 m from its route is flagged "off route".

## Seat availability: the IR door sensor

`hardware/esp32_ir_counter/esp32_ir_counter.ino` is an Arduino sketch for an **ESP32** with **two IR break-beam sensors** placed one behind the other across the door:

- outer beam then inner beam interrupted = a passenger **boarded** (+1)
- inner beam then outer beam interrupted = a passenger **left** (-1)

Two beams are needed because a single beam cannot tell direction. The sketch debounces both sensors, keeps events in memory if Wi-Fi drops, and sends them to the server. The server keeps the live count and shows `capacity - count` as seats free (levels: plenty, some, almost full, full).

Parts: ESP32 dev board, 2 IR break-beam sensor pairs (e.g. E18-D80NK or emitter/receiver pairs), 5 V supply from the bus (via USB car adapter), jumper wires. Wiring is documented at the top of the sketch. If your sensor outputs 5 V, step it down to 3.3 V before it reaches the ESP32 pins.

Test the server without hardware:

```bash
curl -X POST localhost:3000/api/buses/bus1/door -H "Content-Type: application/json" -d '{"event":"in"}'
curl -X POST localhost:3000/api/buses/bus1/door -H "Content-Type: application/json" -d '{"event":"out","count":2}'
curl -X POST localhost:3000/api/buses/bus1/occupancy -H "Content-Type: application/json" -d '{"count":12}'
```

Known limits of IR counting: two people crossing side by side can count as one, and counts drift over a day. Use the driver console's "Set exact passenger count" (or reset the count at the terminus) to correct drift. Counts are passengers on board; set `capacity` to the number you want to treat as "full" (seats, or seats plus a standing allowance).

## API

| Method and path | Body | Purpose |
|---|---|---|
| `GET /api/config` | | stops, routes, buses |
| `GET /api/state` | | snapshot: positions, ETAs per stop, seats |
| `GET /api/stream` | | live updates (Server-Sent Events, 1 per second) |
| `POST /api/buses/:id/location` | `{"lat":26.44,"lng":92.03,"speed":5.2}` (`speed` in m/s, optional) | GPS fix |
| `POST /api/buses/:id/door` | `{"event":"in"\|"out","count":1}` | IR sensor event |
| `POST /api/buses/:id/occupancy` | `{"count":12}` | set the exact count |

If `DEVICE_KEY` is set, POST requests must carry the header `x-api-key: <key>`. Any GPS hardware that can send HTTP POST (a phone, a 4G tracker, an ESP32 with a GPS module) can feed `/location`.

## Project layout

```
server.js                 backend: API, ETA engine, simulator, static files
data/campus.json          stops, routes, buses (edit this)
public/index.html         passenger site
public/style.css, app.js  map, arrivals board, fleet list
public/driver.html        driver GPS and seat-count console
hardware/esp32_ir_counter ESP32 firmware for the door sensors
```

## Next steps

- Persist history (SQLite or Postgres) for ridership analytics and better ETAs by time of day
- Replace the schematic map with Leaflet and OpenStreetMap tiles (route and stop data are already lat/lng)
- Add push notifications ("Bus 2 arrives at Library in 3 min")
