"""Fetch crop profiles for silly-rock-8631 racers from MySQL."""
import json
import pymysql

conn = pymysql.connect(
    host='localhost',
    user='root',
    password='m0b1l3Phone$!',
    database='ttp_restream',
    charset='utf8mb4'
)
cur = conn.cursor()

# Find racer_profile_ids for our three racers
racers = ['bbqdotgov', 'bort8421', 'blessedbe_']
for racer in racers:
    cur.execute("""
        SELECT rp.id, rp.twitch_channel,
               cp.crop_x, cp.crop_y, cp.crop_w, cp.crop_h,
               cp.stream_width, cp.stream_height,
               cp.grid_offset_dx, cp.grid_offset_dy,
               cp.landmarks_json, cp.is_default, cp.label
        FROM racer_profiles rp
        JOIN crop_profiles cp ON cp.racer_profile_id = rp.id
        WHERE rp.twitch_channel = %s AND cp.is_default = 1
    """, (racer,))
    rows = cur.fetchall()
    print(f"\n=== {racer} ===")
    for r in rows:
        lm = json.loads(r[10]) if r[10] else None
        print(f"  id={r[0][:8]}, channel={r[1]}")
        print(f"  crop: x={r[2]}, y={r[3]}, w={r[4]}, h={r[5]}")
        print(f"  stream: {r[6]}x{r[7]}")
        print(f"  grid: dx={r[8]}, dy={r[9]}")
        print(f"  is_default={r[11]}, label={r[12]}")
        print(f"  landmarks: {json.dumps(lm, indent=4)}")

conn.close()
