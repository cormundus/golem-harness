# Entity registry conversion report — 2026-07-20

Old registry: 94 mobs. Merged: 130 mobs.

## Converted, replacing old entry (72)

- armor_stand
- bee
- blaze
- cat
- cave_spider
- chest_minecart
- chicken
- cod
- command_block_minecart
- cow
- creeper
- dolphin
- donkey [parent case-fixed UMouth→Head; parent case-fixed LMouth→Head]
- drowned
- egg
- elder_guardian
- ender_dragon
- eye_of_ender
- ender_pearl
- enderman
- endermite
- evoker
- experience_bottle
- fox
- guardian
- hoglin
- hopper_minecart
- horse [parent case-fixed UMouth→Head; parent case-fixed LMouth→Head]
- husk
- iron_golem
- llama_spit
- minecart
- mule [parent case-fixed UMouth→Head; parent case-fixed LMouth→Head]
- panda
- parrot
- phantom
- pig
- piglin [parent case-fixed leftItem→leftarm]
- piglin_brute [parent case-fixed leftItem→leftarm]
- pillager [parent case-fixed rightItem→rightarm; parent case-fixed leftItem→leftarm]
- player
- pufferfish
- rabbit
- ravager
- salmon
- sheep
- shulker_bullet
- silverfish
- skeleton
- skeleton_horse [parent case-fixed UMouth→Head; parent case-fixed LMouth→Head]
- slime
- snow_golem
- snowball
- spider
- squid
- stray
- strider [rotated cube compensated in bristle5; rotated cube compensated in bristle4; rotated cube compensated in bristle3; rotated cube compensated in bristle2; rotated cube compensated in bristle1; rotated cube compensated in bristle0]
- trident
- tnt_minecart
- tropical_fish
- vex
- villager
- vindicator
- wandering_trader
- witch
- wither
- wither_skeleton
- wither_skull
- wolf
- zoglin
- zombie
- zombie_horse [parent case-fixed UMouth→Head; parent case-fixed LMouth→Head]

## New mobs added (36)

- allay
- armadillo [rotated cube compensated in head; rotated cube compensated in right_ear; rotated cube compensated in left_ear]
- axolotl
- bogged [rotated cube compensated in mushrooms; rotated cube compensated in mushrooms; rotated cube compensated in mushrooms; rotated cube compensated in mushrooms; rotated cube compensated in mushrooms; rotated cube compensated in mushrooms]
- breeze [rotated cube compensated in rods; rotated cube compensated in rods; rotated cube compensated in rods]
- breeze_wind_charge
- camel [rotated cube compensated in tail]
- frog [rotated cube compensated in left_arm; rotated cube compensated in left_leg; rotated cube compensated in right_leg]
- glow_squid
- goat [rotated cube compensated in head]
- nautilus
- sniffer
- splash_potion
- tadpole
- warden
- wind_charge
- oak_boat (alias → boat)
- oak_chest_boat (alias → boat)
- spruce_boat (alias → boat)
- spruce_chest_boat (alias → boat)
- birch_boat (alias → boat)
- birch_chest_boat (alias → boat)
- jungle_boat (alias → boat)
- jungle_chest_boat (alias → boat)
- acacia_boat (alias → boat)
- acacia_chest_boat (alias → boat)
- dark_oak_boat (alias → boat)
- dark_oak_chest_boat (alias → boat)
- mangrove_boat (alias → boat)
- mangrove_chest_boat (alias → boat)
- cherry_boat (alias → boat)
- cherry_chest_boat (alias → boat)
- pale_oak_boat (alias → boat)
- pale_oak_chest_boat (alias → boat)
- bamboo_raft (alias → boat)
- bamboo_chest_raft (alias → boat)

## Kept old entry (no clean conversion) (22)

- arrow
- bat
- boat
- dragon_fireball
- evoker_fangs
- experience_orb
- fireball
- firework_rocket
- fishing_bobber
- ghast
- leash_knot
- llama
- magma_cube
- mooshroom
- ocelot
- polar_bear
- shulker
- small_fireball
- potion
- turtle
- zombified_piglin
- zombie_villager

## Skipped (flagged, old kept if it existed) (42)

- arrow — per-face uv in body
- bat — texture missing: textures/entity/bat_v2
- boat — unresolved geometry geometry.boat
- camel_husk — texture missing: textures/entity/camel_husk/camel_husk
- copper_golem — texture missing: textures/entity/copper_golem/copper_golem
- cow — texture missing: textures/entity/cow/cow_v2
- creaking — texture missing: textures/entity/creaking/creaking
- dragon_fireball — per-face uv in body
- end_crystal — texture missing: textures/entity/endercrystal/endercrystal
- evoker_fangs — texture missing: textures/entity/illager/fangs
- experience_orb — per-face uv in body
- fireball — per-face uv in body
- firework_rocket — per-face uv in body
- fishing_bobber — per-face uv in body
- ghast — per-face uv in body
- happy_ghast — per-face uv in body
- leash_knot — cube without uv in knot
- lingering_potion — texture missing: textures/items/potion_bottle_lingering
- llama — texture missing: textures/entity/llama/llama_creamy
- llama — texture missing: textures/entity/llama/llama_creamy
- magma_cube — texture missing: textures/entity/slime/magmacube_v2
- mooshroom — texture missing: textures/entity/cow/mooshroom_v2
- mooshroom — texture missing: textures/entity/cow/mooshroom
- ocelot — texture missing: textures/entity/cat/blackcat
- ocelot — texture missing: textures/entity/cat/blackcat
- parched — texture missing: textures/entity/parched/parched
- pig — texture missing: textures/entity/pig/pig_v3
- polar_bear — texture missing: textures/entity/polar_bear
- rabbit — texture missing: textures/entity/rabbit/rabbit_brown
- shulker — texture missing: textures/entity/shulker/shulker_undyed
- shulker — texture missing: textures/entity/shulker/shulker_undyed
- small_fireball — per-face uv in body
- trader_llama — texture missing: textures/entity/llama/llama_creamy
- turtle — texture missing: textures/entity/sea_turtle
- villager — texture missing: textures/entity/villager/farmer
- villager — texture missing: textures/entity/villager/farmer
- zombie_nautilus — texture missing: textures/entity/nautilus/zombie_nautilus
- zombified_piglin — texture missing: textures/entity/piglin/zombie_piglin
- zombified_piglin — unresolved geometry geometry.humanoid
- zombie_villager — texture missing: textures/entity/zombie_villager/zombie_smith
- zombie_villager — unresolved geometry geometry.humanoid
- zombie_villager — texture missing: textures/entity/zombie_villager2/zombie-villager

## Texture paths patched (drift rescue) (17)

- armor_stand: textures/entity/armor_stand → textures/items/armor_stand
- breeze_wind_charge: textures/entity/wind_charge → textures/entity/projectiles/wind_charge
- chicken: textures/entity/chicken/chicken → textures/entity/chicken
- ender_dragon: textures/entity/dragon/dragon → textures/entity/enderdragon/dragon
- glow_squid: textures/entity/glow_squid/glow_squid → textures/entity/squid/glow_squid
- iron_golem: textures/entity/iron_golem → textures/entity/iron_golem/iron_golem
- nautilus: textures/entity/nautilus/nautilus → textures/particle/nautilus
- pillager: textures/entity/pillager → textures/entity/illager/pillager
- squid: textures/entity/squid → textures/entity/squid/squid
- vex: textures/entity/vex/vex → textures/entity/illager/vex
- villager: textures/entity/villager2/villager → textures/entity/villager/villager
- vindicator: textures/entity/vindicator → textures/entity/illager/vindicator
- wind_charge: textures/entity/wind_charge → textures/entity/projectiles/wind_charge
- wither: textures/entity/wither_boss/wither → textures/entity/wither/wither
- wither_skull: textures/entity/wither_boss/wither → textures/entity/wither/wither
- zoglin: textures/entity/zoglin/zoglin → textures/entity/hoglin/zoglin
- arrow: textures/entity/arrow → textures/entity/projectiles/arrow

## Textures filled forward into 1.21.1 tree (add to backup tar!) (0)


## Bone-parent repairs (post-merge audit) (1)

- zombified_piglin: parent case-fixed leftItem→leftarm

## UNRESOLVED textures (will render untextured!) (1)

- firework_rocket: texture unresolved anywhere: textures/entity/fireworks

## Bedrock entities with no java match (ignored) (0)

