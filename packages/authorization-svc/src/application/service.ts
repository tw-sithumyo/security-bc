/*****
 License
 --------------
 Copyright © 2017 Bill & Melinda Gates Foundation
 The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

 Contributors
 --------------
 This is the official list (alphabetical ordering) of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.

 * Gates Foundation
 - Name Surname <name.surname@gatesfoundation.com>

 * Crosslake
 - Pedro Sousa Barreto <pedrob@crosslaketech.com>

 --------------
 ******/

"use strict";

import {defaultDevRoles} from "../defaults/dev_defaults";
import {Server} from "http";
import express from "express";

import {LogLevel, ILogger} from "@mojaloop/logging-bc-public-types-lib";
import {KafkaLogger} from "@mojaloop/logging-bc-client-lib";

import {AuthorizationAggregate} from "../domain/authorization_agg";
import { IAuthorizationRepository} from "../domain/interfaces";
import {ExpressRoutes} from "./routes";
import {MongoDbAuthorizationRepo} from "../infrastructure/mongodb_authorization_repo";
import process from "process";
import {IMessageConsumer, IMessageProducer} from "@mojaloop/platform-shared-lib-messaging-types-lib";
import {
    MLKafkaJsonConsumer, MLKafkaJsonConsumerOptions,
    MLKafkaJsonProducer
} from "@mojaloop/platform-shared-lib-nodejs-kafka-client-lib/dist/index";
import {TokenHelper} from "@mojaloop/security-bc-client-lib";
import {ITokenHelper} from "@mojaloop/security-bc-public-types-lib";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJSON = require("../../package.json");

const BC_NAME = "security-bc";
const APP_NAME = "authorization-svc";
const APP_VERSION = packageJSON.version;
const PRODUCTION_MODE = process.env["PRODUCTION_MODE"] || false;
const LOG_LEVEL:LogLevel = process.env["LOG_LEVEL"] as LogLevel || LogLevel.DEBUG;

const SVC_DEFAULT_HTTP_PORT = 3202;

const AUTH_N_SVC_BASEURL = process.env["AUTH_N_SVC_BASEURL"] || "http://localhost:3201";
const AUTH_N_TOKEN_ISSUER_NAME = process.env["AUTH_N_TOKEN_ISSUER_NAME"] || "mojaloop.vnext.dev.default_issuer";
const AUTH_N_TOKEN_AUDIENCE = process.env["AUTH_N_TOKEN_AUDIENCE"] || "mojaloop.vnext.dev.default_audience";
const AUTH_N_SVC_JWKS_URL = process.env["AUTH_N_SVC_JWKS_URL"] || `${AUTH_N_SVC_BASEURL}/.well-known/jwks.json`;


const KAFKA_URL = process.env["KAFKA_URL"] || "localhost:9092";
const MONGO_URL = process.env["MONGO_URL"] || "mongodb://root:mongoDbPas42@localhost:27017/";

//const KAFKA_AUDITS_TOPIC = process.env["KAFKA_AUDITS_TOPIC"] || "audits";
const KAFKA_LOGS_TOPIC = process.env["KAFKA_LOGS_TOPIC"] || "logs";

// kafka logger
const kafkaProducerOptions = {
    kafkaBrokerList: KAFKA_URL
};

const kafkaConsumerOptions: MLKafkaJsonConsumerOptions = {
    kafkaBrokerList: KAFKA_URL,
    kafkaGroupId: `${BC_NAME}_${APP_NAME}`
};

// global
let globalLogger: ILogger;

export class Service {
    static logger: ILogger;
    static authorizationRepo: IAuthorizationRepository;
    static messageProducer: IMessageProducer;
    static messageConsumer: IMessageConsumer;
    static tokenHelper: ITokenHelper;
    static authorizationAggregate:AuthorizationAggregate;
    static expressServer: Server;

    static async start(
		logger?: ILogger,
		authNRepo?:IAuthorizationRepository,
        messageProducer?: IMessageProducer,
        messageConsumer?: IMessageConsumer
    ):Promise<void>{
        if (!logger) {
            logger = new KafkaLogger(
                    BC_NAME,
                    APP_NAME,
                    APP_VERSION,
                    kafkaProducerOptions,
                    KAFKA_LOGS_TOPIC,
                    LOG_LEVEL
            );
            await (logger as KafkaLogger).init();
        }
        globalLogger = this.logger = logger.createChild("Service");

        if(!authNRepo){
            authNRepo = new MongoDbAuthorizationRepo(MONGO_URL, logger);
            await authNRepo.init();
        }
        this.authorizationRepo = authNRepo;

        if (!messageProducer) {
            const producerLogger = logger.createChild("producerLogger");
            producerLogger.setLogLevel(LogLevel.INFO);
            messageProducer = new MLKafkaJsonProducer(kafkaProducerOptions, producerLogger);
            await messageProducer.connect();
        }
        this.messageProducer = messageProducer;

        // message consumer for agg change detection (from other instances)
        if(!messageConsumer){
            const consumerHandlerLogger = logger.createChild("handlerConsumer");
            consumerHandlerLogger.setLogLevel(LogLevel.INFO);
            messageConsumer = new MLKafkaJsonConsumer(kafkaConsumerOptions, consumerHandlerLogger);
        }
        this.messageConsumer = messageConsumer;

        // instantiate and init the aggregate
        this.authorizationAggregate = new AuthorizationAggregate(
            this.authorizationRepo,
            this.messageProducer,
            this.messageConsumer,
            BC_NAME,
            APP_NAME,
            APP_VERSION,
            this.logger
        );

        // create default roles if non exist - CONSIDER moving this logic to inside the aggregate
        const existingRoles = await this.authorizationRepo.fetchAllPlatformRoles();
        if (existingRoles.length<=0){
            if(PRODUCTION_MODE) {
                //TODO create default PROD roles
                this.logger.warn("In PRODUCTION_MODE and no platformRoles found");
            }else{
                // create default dev roles
                this.logger.warn("Not in PRODUCTION_MODE and no platformRoles found - creating dev default platformRole(s)...");
                await this.authorizationAggregate.bootstrapDefaultRoles(defaultDevRoles);
                this.logger.warn(`Created ${defaultDevRoles.length} dev default platformRole(s)`);
            }
        }

        // now we can init (after bootstrapping if needed)
        await this.authorizationAggregate.init();

        // token helper, needed by the http routes' middleware
        this.tokenHelper = new TokenHelper(AUTH_N_SVC_JWKS_URL, logger, AUTH_N_TOKEN_ISSUER_NAME, AUTH_N_TOKEN_AUDIENCE);
        await this.tokenHelper.init();

        this.setupAndStartExpress();
    }

    static setupAndStartExpress():void {
        const app = express();
        app.use(express.json()); // for parsing application/json
        app.use(express.urlencoded({extended: true})); // for parsing application/x-www-form-urlencoded

        const routes = new ExpressRoutes(this.authorizationAggregate, this.tokenHelper, this.logger);
        app.use("/", routes.MainRouter);
        app.use("/appPrivileges", routes.PrivilegesRouter);

        app.use("/platformRoles", routes.RolesRouter);

        app.use((req, res) => {
            // catch all
            res.send(404);
        });

        let portNum = SVC_DEFAULT_HTTP_PORT;
        if(process.env["SVC_HTTP_PORT"] && !isNaN(parseInt(process.env["SVC_HTTP_PORT"]))) {
            portNum = parseInt(process.env["SVC_HTTP_PORT"]);
        }

        this.expressServer = app.listen(portNum, () => {
            console.log(`🚀 Server ready at: http://localhost:${portNum}`);
            this.logger.info(`Authorization service v: ${APP_VERSION} started`);
        }).on("error", err => {
            this.logger.fatal(err);
            process.exit(9);
        });
    }

    static async stop():Promise<void>{
        if(this.expressServer) this.expressServer.close();
    }
}


/**
 * process termination and cleanup
 */

async function _handle_int_and_term_signals(signal: NodeJS.Signals): Promise<void> {
    console.info(`Service - ${signal} received - cleaning up...`);
    await Service.stop();
    process.exit();
}

//catches ctrl+c event
process.on("SIGINT", _handle_int_and_term_signals);
//catches program termination event
process.on("SIGTERM", _handle_int_and_term_signals);

//do something when app is closing
process.on("exit", async () => {
    globalLogger.info("Microservice - exiting...");
});
process.on("uncaughtException", (err: Error) => {
    console.error(err);
    process.exit(99);
});
