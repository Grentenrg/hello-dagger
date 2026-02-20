import {
  dag,
  Container,
  Directory,
  Service,
  object,
  func,
  argument,
  check
} from '@dagger.io/dagger'

@object()
export class HelloDagger {
  /**
   * Publish the application container after building and testing it on-the-fly
   */
  @func()
  async publish(@argument({ defaultPath: '/' }) source: Directory): Promise<string> {
    await this.test(source)
    return await this.build(source).publish(
      'ttl.sh/hello-dagger-' + Math.floor(Math.random() * 10000000)
    )
  }

  /**
   * Build the frontend application container
   */
  @func()
  build(@argument({ defaultPath: '/' }) source: Directory): Container {
    const build = this.buildEnv(source).withExec(['npm', 'run', 'build']).directory('./dist')

    return dag
      .container()
      .from('nginx:1.25-alpine')
      .withDirectory('/usr/share/nginx/html', build)
      .withExposedPort(80)
  }

  /**
   * Return the result of running unit tests
   */
  @func()
  async test(@argument({ defaultPath: '/' }) source: Directory): Promise<string> {
    return this.buildEnv(source).withExec(['npm', 'run', 'test:unit', 'run']).stdout()
  }

  /**
   * Build a ready-to-use development environment
   */
  @func()
  buildEnv(@argument({ defaultPath: '/' }) source: Directory): Container {
    const nodeCache = dag.cacheVolume('node')
    return dag
      .container()
      .from('node:21-slim')
      .withDirectory('/src', source)
      .withMountedCache('/root/.npm', nodeCache)
      .withWorkdir('/src')
      .withExec(['npm', 'install'])
  }

  /**
   * Validate that the application builds successfully
   */
  @func()
  @check()
  async validateBuild(
    @argument({ defaultPath: '/', ignore: ['.git', 'node_modules'] })
    source?: Directory
  ): Promise<void> {
    await this.build(source).sync()
  }

  @func()
  @check()
  async curlTest(@argument({ defaultPath: '/' }) source: Directory): Promise<string> {
    const container = this.build(source)
    const svc = container.asService()

    return await dag
      .container()
      .from('curlimages/curl:8.4.0')
      .withServiceBinding('app', svc)
      .withExec(['curl', '--fail', '--silent', '--show-error', 'http://app:80'])
      .stdout()
  }

  /**
   * Create a PostgreSQL service
   */
  @func()
  postgres(): Service {
    return dag
      .container()
      .from('postgres:16-alpine')
      .withEnvVariable('POSTGRES_USER', 'postgres')
      .withEnvVariable('POSTGRES_PASSWORD', 'postgres')
      .withEnvVariable('POSTGRES_DB', 'testdb')
      .withExposedPort(5432)
      .asService()
  }

  /**
   * Create a Redis service
   */
  @func()
  redis(): Service {
    return dag
      .container()
      .from('redis:7-alpine')
      .withExposedPort(6379)
      .asService()
  }

  /**
   * Create a Kafka service (using apache/kafka in KRaft mode)
   */
  @func()
  kafka(): Service {
    return dag
      .container()
      .from('apache/kafka:3.7.0')
      .withEnvVariable('KAFKA_NODE_ID', '1')
      .withEnvVariable('KAFKA_PROCESS_ROLES', 'broker,controller')
      .withEnvVariable('KAFKA_LISTENERS', 'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093')
      .withEnvVariable('KAFKA_ADVERTISED_LISTENERS', 'PLAINTEXT://kafka:9092')
      .withEnvVariable('KAFKA_CONTROLLER_LISTENER_NAMES', 'CONTROLLER')
      .withEnvVariable('KAFKA_LISTENER_SECURITY_PROTOCOL_MAP', 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT')
      .withEnvVariable('KAFKA_CONTROLLER_QUORUM_VOTERS', '1@localhost:9093')
      .withEnvVariable('KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR', '1')
      .withEnvVariable('KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR', '1')
      .withEnvVariable('KAFKA_TRANSACTION_STATE_LOG_MIN_ISR', '1')
      .withEnvVariable('KAFKA_AUTO_CREATE_TOPICS_ENABLE', 'true')
      .withEnvVariable('CLUSTER_ID', 'MkU3OEVBNTcwNTJENDM2Qk')
      .withExposedPort(9092)
      .asService()
  }

  /**
   * Build the backend container
   */
  @func()
  buildBackend(@argument({ defaultPath: '/' }) source: Directory): Container {
    const backendDir = source.directory('backend')
    const nodeCache = dag.cacheVolume('node-backend')

    return dag
      .container()
      .from('node:21-slim')
      .withDirectory('/app', backendDir)
      .withMountedCache('/root/.npm', nodeCache)
      .withWorkdir('/app')
      .withExec(['npm', 'install'])
      .withExposedPort(3000)
      .withEnvVariable('PORT', '3000')
  }

  /**
   * Run the backend with only PostgreSQL
   */
  @func()
  backendWithPostgres(@argument({ defaultPath: '/' }) source: Directory): Service {
    const pg = this.postgres()

    return this.buildBackend(source)
      .withServiceBinding('postgres', pg)
      .withEnvVariable('ENABLE_POSTGRES', 'true')
      .withEnvVariable('POSTGRES_HOST', 'postgres')
      .withDefaultArgs(['npm', 'start'])
      .asService()
  }

  /**
   * Run the backend with only Redis
   */
  @func()
  backendWithRedis(@argument({ defaultPath: '/' }) source: Directory): Service {
    const redis = this.redis()

    return this.buildBackend(source)
      .withServiceBinding('redis', redis)
      .withEnvVariable('ENABLE_REDIS', 'true')
      .withEnvVariable('REDIS_HOST', 'redis')
      .withDefaultArgs(['npm', 'start'])
      .asService()
  }

  /**
   * Run the backend with only Kafka
   */
  @func()
  backendWithKafka(@argument({ defaultPath: '/' }) source: Directory): Service {
    const kafka = this.kafka()

    return this.buildBackend(source)
      .withServiceBinding('kafka', kafka)
      .withEnvVariable('ENABLE_KAFKA', 'true')
      .withEnvVariable('KAFKA_HOST', 'kafka')
      .withDefaultArgs(['npm', 'start'])
      .asService()
  }

  /**
   * Test PostgreSQL endpoint
   */
  @func()
  @check()
  async testPostgres(@argument({ defaultPath: '/' }) source: Directory): Promise<string> {
    const backend = this.backendWithPostgres(source)

    return await dag
      .container()
      .from('alpine:3.19')
      .withExec(['apk', 'add', '--no-cache', 'curl'])
      .withServiceBinding('backend', backend)
      .withExec([
        'sh', '-c', `
          set -e
          echo "Waiting for backend to be ready..."
          for i in $(seq 1 30); do
            if curl -sf http://backend:3000/ready > /dev/null 2>&1; then
              echo "Backend ready!"
              break
            fi
            echo "Attempt $i: not ready, waiting..."
            sleep 1
          done

          echo "Creating item..."
          CREATE=$(curl -sf -X POST -H "Content-Type: application/json" -d '{"name":"test-item","value":"test-value"}' http://backend:3000/postgres/items)
          echo "Create result: $CREATE"

          echo "Reading items..."
          READ=$(curl -sf http://backend:3000/postgres/items)
          echo "Read result: $READ"
        `
      ])
      .stdout()
  }

  /**
   * Test Redis endpoint
   */
  @func()
  @check()
  async testRedis(@argument({ defaultPath: '/' }) source: Directory): Promise<string> {
    const backend = this.backendWithRedis(source)

    return await dag
      .container()
      .from('alpine:3.19')
      .withExec(['apk', 'add', '--no-cache', 'curl'])
      .withServiceBinding('backend', backend)
      .withExec([
        'sh', '-c', `
          set -e
          echo "Waiting for backend to be ready..."
          for i in $(seq 1 30); do
            if curl -sf http://backend:3000/ready > /dev/null 2>&1; then
              echo "Backend ready!"
              break
            fi
            echo "Attempt $i: not ready, waiting..."
            sleep 1
          done

          echo "Setting key..."
          SET=$(curl -sf -X POST -H "Content-Type: application/json" -d '{"key":"test-key","value":"test-value"}' http://backend:3000/redis/keys)
          echo "Set result: $SET"

          echo "Getting key..."
          GET=$(curl -sf http://backend:3000/redis/keys/test-key)
          echo "Get result: $GET"
        `
      ])
      .stdout()
  }

  /**
   * Test Kafka endpoint
   */
  @func()
  @check()
  async testKafka(@argument({ defaultPath: '/' }) source: Directory): Promise<string> {
    const backend = this.backendWithKafka(source)

    return await dag
      .container()
      .from('alpine:3.19')
      .withExec(['apk', 'add', '--no-cache', 'curl'])
      .withServiceBinding('backend', backend)
      .withExec([
        'sh', '-c', `
          set -e
          echo "Waiting for backend to be ready (Kafka takes longer)..."
          for i in $(seq 1 60); do
            if curl -sf http://backend:3000/ready > /dev/null 2>&1; then
              echo "Backend ready!"
              break
            fi
            echo "Attempt $i: not ready, waiting..."
            sleep 2
          done

          echo "Sending message..."
          SEND=$(curl -sf -X POST -H "Content-Type: application/json" -d '{"topic":"test-topic","message":{"hello":"world"}}' http://backend:3000/kafka/messages)
          echo "Send result: $SEND"

          sleep 2

          echo "Reading messages..."
          READ=$(curl -sf http://backend:3000/kafka/messages)
          echo "Read result: $READ"
        `
      ])
      .stdout()
  }
}
