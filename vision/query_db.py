"""Query MySQL for crop profiles."""
import pymysql

conn = pymysql.connect(
    host='localhost', port=3306, user='root',
    password='m0b1l3Phone$!', database='ttp_restream'
)
cur = conn.cursor()
cur.execute("""
    SELECT rp.display_name, rp.twitch_channel, cp.label,
           cp.crop_x, cp.crop_y, cp.crop_w, cp.crop_h,
           cp.stream_width, cp.stream_height,
           cp.grid_offset_dx, cp.grid_offset_dy, cp.is_default,
           cp.landmarks_json
    FROM crop_profiles cp
    JOIN racer_profiles rp ON cp.racer_profile_id=rp.id
    ORDER BY rp.display_name, cp.is_default DESC
""")
rows = cur.fetchall()
print('display_name | channel | label | x | y | w | h | sw | sh | dx | dy | default | has_landmarks')
for r in rows:
    has_lm = 'yes' if r[12] else 'no'
    print(' | '.join(str(x) for x in r[:12]) + f' | {has_lm}')
conn.close()
