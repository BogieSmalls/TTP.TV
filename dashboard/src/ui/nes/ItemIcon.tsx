interface ItemIconProps {
  item: string;
  size?: number;
}

export function ItemIcon({ item, size = 16 }: ItemIconProps) {
  const src = `/vision/templates/items/${item}.png`;
  return (
    <img
      src={src}
      alt={item}
      width={size}
      height={size * 2}
      style={{ imageRendering: 'pixelated' }}
      className="inline-block"
      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
    />
  );
}
