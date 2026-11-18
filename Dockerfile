FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json index.tsx ./
CMD ["bun", "index.tsx"]
