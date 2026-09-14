# 羽衣电竞陪玩制度问答 · 自建 RAG 引擎
# 零第三方依赖，因此不需要 npm install，镜像很小、构建很快。
#
# 微信云托管会用这个文件构建容器。默认监听 80，控制台「服务设置 - 端口」也填 80。

FROM node:18-alpine

WORKDIR /app

# 只拷服务端需要的东西（小程序代码不进镜像）
COPY package.json ./
COPY server/ ./server/
COPY scripts/ ./scripts/

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=80
# 容器文件系统不持久：知识库为空时自动导入 server/knowledge 里的制度文档
ENV AUTO_SEED=true

EXPOSE 80

# 健康检查探针（云托管控制台可配到 /health）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||80)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
