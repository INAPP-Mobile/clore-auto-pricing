FROM oven/bun:1
WORKDIR /app
COPY package.json index.tsx ./
CMD ["bun", "index.tsx"]
